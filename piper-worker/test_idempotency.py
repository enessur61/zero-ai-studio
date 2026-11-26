import tempfile
import unittest
from pathlib import Path
import app as worker

class PiperIdempotencyStoreTests(unittest.TestCase):
    def test_completed_result_replays_exact_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            db = Path(directory) / "idempotency.sqlite3"
            worker.initialize_idempotency_store(db)
            state, audio = worker.claim_tts_idempotency("local-key-0001", "a" * 64, db)
            self.assertEqual((state, audio), ("new", None))
            self.assertEqual(worker.claim_tts_idempotency("local-key-0001", "a" * 64, db), ("processing", None))
            expected = b"RIFF" + b"\x00" * 48
            worker.complete_tts_idempotency("local-key-0001", expected, db)
            self.assertEqual(worker.claim_tts_idempotency("local-key-0001", "a" * 64, db), ("completed", expected))
            self.assertEqual(worker.claim_tts_idempotency("local-key-0001", "b" * 64, db), ("conflict", None))

    def test_interrupted_processing_becomes_unknown_after_restart(self):
        with tempfile.TemporaryDirectory() as directory:
            db = Path(directory) / "idempotency.sqlite3"
            worker.initialize_idempotency_store(db)
            self.assertEqual(worker.claim_tts_idempotency("local-key-0002", "c" * 64, db), ("new", None))
            worker.initialize_idempotency_store(db)  # simulates worker process restart
            self.assertEqual(worker.claim_tts_idempotency("local-key-0002", "c" * 64, db), ("unknown", None))
            self.assertEqual(worker.claim_tts_idempotency("local-key-0002", "d" * 64, db), ("conflict", None))

if __name__ == "__main__":
    unittest.main()
