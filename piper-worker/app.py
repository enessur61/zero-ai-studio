from __future__ import annotations
import hashlib, hmac, io, os, threading, urllib.request, wave
from pathlib import Path
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field
from piper import PiperVoice
from piper.config import SynthesisConfig

APP_TOKEN=os.environ.get("ZERO_TTS_WORKER_TOKEN","").strip()
MODEL_DIR=Path(os.environ.get("PIPER_MODEL_DIR","/tmp/zero-piper"))
MODEL_DIR.mkdir(parents=True,exist_ok=True)
REV="95119a449dcd66ed7ad199313f76bda3eda7e286"
VOICE="de_DE-thorsten-medium"
URLS={
 "model":f"https://huggingface.co/rhasspy/piper-voices/resolve/{REV}/de/de_DE/thorsten/medium/{VOICE}.onnx",
 "config":f"https://huggingface.co/rhasspy/piper-voices/resolve/{REV}/de/de_DE/thorsten/medium/{VOICE}.onnx.json",
}
MD5={"model":"a129b00fb3078df43c96bab6c94535c0","config":"843a7bd7272724f750534dd5a26d1aad"}
MODEL=MODEL_DIR/f"{VOICE}.onnx"; CONFIG=MODEL_DIR/f"{VOICE}.onnx.json"
app=FastAPI(title="ZERO German Piper TTS",version="1.0.0")
voice=None
voice_lock=threading.Lock()
synth_lock=threading.Lock()

class Request(BaseModel):
 text:str=Field(min_length=1,max_length=5000)
 speed:float=Field(default=1.0,ge=0.75,le=1.25)

def auth(value:str|None):
 if not APP_TOKEN: raise HTTPException(503,"TTS worker authentication is not configured")
 supplied=value.removeprefix("Bearer ").strip() if value else ""
 if not hmac.compare_digest(supplied,APP_TOKEN): raise HTTPException(401,"Unauthorized")

def md5(path:Path)->str:
 d=hashlib.md5()
 with path.open("rb") as f:
  for chunk in iter(lambda:f.read(1024*1024),b""): d.update(chunk)
 return d.hexdigest()

def download(key:str,dest:Path,max_bytes:int):
 if dest.is_file() and dest.stat().st_size<=max_bytes and md5(dest)==MD5[key]: return
 dest.unlink(missing_ok=True); tmp=dest.with_suffix(dest.suffix+".part"); d=hashlib.md5(); total=0
 req=urllib.request.Request(URLS[key],headers={"User-Agent":"ZERO-AI-STUDIO/1.0"})
 try:
  with urllib.request.urlopen(req,timeout=60) as response,tmp.open("wb") as out:
   while chunk:=response.read(1024*1024):
    total+=len(chunk)
    if total>max_bytes: raise RuntimeError("Voice file exceeded download size limit")
    d.update(chunk); out.write(chunk)
  if d.hexdigest()!=MD5[key]: raise RuntimeError("Piper voice failed published integrity check")
  tmp.replace(dest)
 except Exception:
  tmp.unlink(missing_ok=True); raise

def get_voice():
 global voice
 with voice_lock:
  if voice is None:
   download("model",MODEL,100*1024*1024); download("config",CONFIG,1024*1024)
   voice=PiperVoice.load(str(MODEL),config_path=str(CONFIG))
  return voice

def synthesize(text:str,speed:float)->bytes:
 clean=text.strip()
 if not clean: raise ValueError("Text für die Sprachausgabe fehlt")
 if len(clean)>5000: raise ValueError("Maximal 5.000 Zeichen pro WAV-Datei")
 cfg=SynthesisConfig(volume=1.0,length_scale=1.0/min(1.25,max(0.75,speed)),noise_scale=0.667,noise_w_scale=0.8,normalize_audio=True)
 buf=io.BytesIO()
 with synth_lock,wave.open(buf,"wb") as wav:
  get_voice().synthesize_wav(clean,wav,syn_config=cfg)
 audio=buf.getvalue()
 if len(audio)<44 or audio[:4]!=b"RIFF" or audio[8:12]!=b"WAVE": raise RuntimeError("Piper returned invalid WAV")
 if len(audio)>20*1024*1024: raise RuntimeError("Piper WAV exceeded 20-MB limit")
 return audio

@app.get("/health")
def health():
 return {"ok":True,"engine":"Piper ONNX","voice":VOICE,"voice_loaded":voice is not None,"cost_eur":0,"paid_fallback":False}

@app.post("/tts")
def tts(request:Request,authorization:str|None=Header(default=None)):
 auth(authorization)
 try: audio=synthesize(request.text,request.speed)
 except ValueError as exc: raise HTTPException(400,str(exc)) from exc
 except Exception as exc: raise HTTPException(503,f"Piper TTS unavailable: {str(exc)[:240]}") from exc
 return Response(content=audio,media_type="audio/wav",headers={"Content-Length":str(len(audio)),"Content-Disposition":'attachment; filename="zero-piper-de.wav"',"X-Zero-TTS-Model":VOICE,"X-Zero-TTS-Cost":"0"})
