from __future__ import annotations
import hashlib, hmac, io, os, platform, threading, urllib.request, wave
from pathlib import Path
from urllib.parse import urlsplit
import httpx
import onnxruntime as ort
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field
from piper import PiperVoice, SynthesisConfig
from voice_assets import MODEL_SHA256, MODEL_SIZE_BYTES, VOICE_ID, VOICE_REVISION, validate_model_file, validate_voice_config

APP_TOKEN=os.environ.get("ZERO_TTS_WORKER_TOKEN","").strip()
MODEL_DIR=Path(os.environ.get("PIPER_MODEL_DIR","/var/lib/zero-piper"))
MODEL_DIR.mkdir(parents=True,exist_ok=True)
REV=VOICE_REVISION
VOICE=VOICE_ID
URLS={
 "model":f"https://huggingface.co/rhasspy/piper-voices/resolve/{REV}/de/de_DE/thorsten/medium/{VOICE}.onnx",
 "config":f"https://huggingface.co/rhasspy/piper-voices/resolve/{REV}/de/de_DE/thorsten/medium/{VOICE}.onnx.json",
}
MD5={"model":"e2fe077168bfe802e951e717dfa85873","config":"dac4f7530c978753aeb40f214245659f"}
EXPECTED_SIZES={"model":MODEL_SIZE_BYTES,"config":6455}
SHA256={"model":MODEL_SHA256,"config":None}
NOISE_SCALE=0.5
NOISE_W_SCALE=0.333
MODEL=MODEL_DIR/f"{VOICE}.onnx"; CONFIG=MODEL_DIR/f"{VOICE}.onnx.json"
app=FastAPI(title="ZERO German Piper TTS",version="1.0.0")
voice=None
voice_lock=threading.Lock()
synth_lock=threading.Lock()
ONNX_PROVIDERS=ort.get_available_providers()
if "CPUExecutionProvider" not in ONNX_PROVIDERS:
 raise RuntimeError("Piper requires ONNX Runtime CPUExecutionProvider; CUDA is not required")

class Request(BaseModel):
 text:str=Field(min_length=1,max_length=5000)
 speed:float=Field(default=1.0,ge=0.75,le=1.25)

def token_is_configured()->bool:
 return len(APP_TOKEN)>=32 and not APP_TOKEN.lower().startswith(("replace-", "changeme", "example"))

def auth(value:str|None):
 if not token_is_configured(): raise HTTPException(503,"TTS worker authentication is not securely configured")
 supplied=value.removeprefix("Bearer ").strip() if value else ""
 if not hmac.compare_digest(supplied,APP_TOKEN): raise HTTPException(401,"Unauthorized")

def md5(path:Path)->str:
 d=hashlib.md5()
 with path.open("rb") as f:
  for chunk in iter(lambda:f.read(1024*1024),b""): d.update(chunk)
 return d.hexdigest()

def sha256(path:Path)->str:
 d=hashlib.sha256()
 with path.open("rb") as f:
  for chunk in iter(lambda:f.read(1024*1024),b""): d.update(chunk)
 return d.hexdigest()

def validate_asset(key:str,path:Path):
 if key=="model": validate_model_file(path, expected_size=EXPECTED_SIZES[key], expected_sha256=SHA256[key])
 elif key=="config": validate_voice_config(path)
 else: raise RuntimeError("Unknown Piper voice asset")

def download(key:str,dest:Path,max_bytes:int):
 expected_size=EXPECTED_SIZES[key]
 expected_sha256=SHA256[key]
 if (dest.is_file() and dest.stat().st_size==expected_size
     and md5(dest)==MD5[key]
     and (expected_sha256 is None or sha256(dest)==expected_sha256)):
  try:
   validate_asset(key,dest)
   return
  except Exception:
   dest.unlink(missing_ok=True)
 dest.unlink(missing_ok=True); tmp=dest.with_suffix(dest.suffix+".part")
 md5_digest=hashlib.md5(); sha256_digest=hashlib.sha256(); total=0
 req=urllib.request.Request(URLS[key],headers={"User-Agent":"ZERO-AI-STUDIO/1.0"})
 try:
  with urllib.request.urlopen(req,timeout=60) as response,tmp.open("wb") as out:
   while chunk:=response.read(1024*1024):
    total+=len(chunk)
    if total>max_bytes or total>expected_size:
     raise RuntimeError("Piper voice file exceeded its pinned size limit")
    md5_digest.update(chunk); sha256_digest.update(chunk); out.write(chunk)
  if total!=expected_size:
   raise RuntimeError("Piper voice file size does not match pinned metadata")
  if md5_digest.hexdigest()!=MD5[key]:
   raise RuntimeError("Piper voice failed published MD5 integrity check")
  if expected_sha256 is not None and sha256_digest.hexdigest()!=expected_sha256:
   raise RuntimeError("Piper voice failed pinned SHA-256 integrity check")
  validate_asset(key,tmp)
  tmp.replace(dest)
 except Exception:
  tmp.unlink(missing_ok=True); raise

def get_voice():
 global voice
 with voice_lock:
  if voice is None:
   download("model",MODEL,100*1024*1024); download("config",CONFIG,1024*1024)
   voice=PiperVoice.load(str(MODEL), use_cuda=False)
  return voice

def synthesize(text:str,speed:float)->bytes:
 clean=text.strip()
 if not clean: raise ValueError("Text für die Sprachausgabe fehlt")
 if len(clean)>5000: raise ValueError("Maximal 5.000 Zeichen pro WAV-Datei")
 cfg=SynthesisConfig(volume=1.0,length_scale=1.0/min(1.25,max(0.75,speed)),noise_scale=NOISE_SCALE,noise_w_scale=NOISE_W_SCALE,normalize_audio=True)
 buf=io.BytesIO()
 with synth_lock,wave.open(buf,"wb") as wav:
  get_voice().synthesize_wav(clean,wav,syn_config=cfg)
 audio=buf.getvalue()
 if len(audio)<44 or audio[:4]!=b"RIFF" or audio[8:12]!=b"WAVE": raise RuntimeError("Piper returned invalid WAV")
 if len(audio)>20*1024*1024: raise RuntimeError("Piper WAV exceeded 20-MB limit")
 return audio

@app.get("/health")
def health():
 if not token_is_configured():
  raise HTTPException(503,"TTS worker authentication is not securely configured")
 return {"ok":True,"auth_configured":True,"engine":"Piper ONNX CPU","model_id":VOICE,"voice":VOICE,"voice_revision":REV,"model_revision":REV,"voice_sample_rate":22050,"voice_loaded":voice is not None,"architecture":platform.machine(),"execution_providers":ONNX_PROVIDERS,"engine_version":__import__("importlib.metadata",fromlist=["version"]).version("piper-tts"),"engine_license":"GPL-3.0-or-later","voice_dataset_license":"CC0","voice_training_base":"rdh (nl_BE, one Flemish speaker, CC0)","model_sha256":MODEL_SHA256,"commercial_use_confirmed":False,"model_dir":str(MODEL_DIR),"cost_eur":0,"paid_fallback":False}

@app.post("/tts")
def tts(request:Request,authorization:str|None=Header(default=None)):
 auth(authorization)
 try: audio=synthesize(request.text,request.speed)
 except ValueError as exc: raise HTTPException(400,str(exc)) from exc
 except Exception as exc: raise HTTPException(503,f"Piper TTS unavailable: {str(exc)[:240]}") from exc
 return Response(content=audio,media_type="audio/wav",headers={"Content-Length":str(len(audio)),"Content-Disposition":'attachment; filename="zero-piper-de.wav"',"X-Zero-TTS-Model":VOICE,"X-Zero-TTS-Revision":REV,"X-Zero-TTS-Cost":"0"})


def normalize_search_results(payload: dict, limit: int = 8) -> list[dict[str, str]]:
    raw_results = payload.get("results")
    if not isinstance(raw_results, list):
        raise RuntimeError("SearXNG returned an invalid results document")
    normalized: list[dict[str, str]] = []
    seen: set[str] = set()
    for item in raw_results:
        if not isinstance(item, dict):
            continue
        raw_url = item.get("url")
        raw_title = item.get("title")
        raw_content = item.get("content")
        if not isinstance(raw_url, str) or not isinstance(raw_title, str):
            continue
        url = raw_url.strip()
        parts = urlsplit(url)
        if parts.scheme not in {"https", "http"} or not parts.hostname or parts.username or parts.password:
            continue
        if url in seen:
            continue
        seen.add(url)
        normalized.append({
            "title": raw_title.strip()[:300] or parts.hostname,
            "url": url[:2048],
            "content": raw_content.strip()[:1200] if isinstance(raw_content, str) else "",
            "engine": ",".join(str(x) for x in (item.get("engines") or [])[:4])[:120],
        })
        if len(normalized) >= max(1, min(limit, 8)):
            break
    return normalized


@app.get("/search")
async def search(
    q: str,
    language: str = "de",
    limit: int = 8,
    authorization: str | None = Header(default=None),
) -> dict[str, object]:
    auth(authorization)
    query = q.strip()
    if not query or len(query) > 250:
        raise HTTPException(status_code=400, detail="Die Suchanfrage muss zwischen 1 und 250 Zeichen lang sein")
    search_url = os.environ.get("SEARXNG_URL", "").strip()
    if not search_url:
        raise HTTPException(status_code=503, detail="SearXNG ist auf diesem Piper-Worker nicht verbunden")
    parts = urlsplit(search_url)
    if parts.scheme not in {"https", "http"} or not parts.hostname or parts.username or parts.password:
        raise HTTPException(status_code=503, detail="SearXNG URL ist ungültig")
    try:
        async with httpx.AsyncClient(timeout=18.0, follow_redirects=False) as client:
            response = await client.get(
                search_url.rstrip("/") + "/search",
                params={
                    "q": query,
                    "format": "json",
                    "language": language if language in {"de", "en", "all"} else "de",
                    "safesearch": "1",
                },
                headers={"Accept": "application/json"},
            )
        if response.status_code != 200:
            raise HTTPException(status_code=503, detail=f"SearXNG antwortete mit HTTP {response.status_code}")
        payload = response.json()
        if not isinstance(payload, dict):
            raise RuntimeError("SearXNG returned non-object JSON")
        results = normalize_search_results(payload, limit)
        return {
            "query": query,
            "results": results,
            "count": len(results),
            "engine": "SearXNG (self-hosted)",
            "cost_eur": 0,
            "paid_fallback": False,
        }
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"SearXNG ist nicht erreichbar: {str(exc)[:180]}") from exc
