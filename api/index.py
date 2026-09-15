import os
import sys
from pathlib import Path

# Add workspace root to sys.path so backend module can be found
ROOT_DIR = Path(__file__).resolve().parent.parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

# Ensure VERCEL environment variable is recognized
os.environ.setdefault("VERCEL", "1")

from backend.app import app
