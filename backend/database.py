import os
from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DATABASE_URL = os.getenv("DATABASE_URL")
if not DATABASE_URL:
    if os.getenv("VERCEL"):
        import shutil
        tmp_dir = Path("/tmp/dhara_data")
        tmp_dir.mkdir(parents=True, exist_ok=True)
        tmp_db = tmp_dir / "dhara.db"
        src_db = PROJECT_ROOT / "data" / "dhara.db"
        if not tmp_db.exists() and src_db.exists():
            shutil.copy2(src_db, tmp_db)
        DATABASE_URL = f"sqlite:///{tmp_db}"
    else:
        DEFAULT_DB = PROJECT_ROOT / "data" / "dhara.db"
        DEFAULT_DB.parent.mkdir(parents=True, exist_ok=True)
        DATABASE_URL = f"sqlite:///{DEFAULT_DB}"
engine_options = {"pool_pre_ping": True}
if DATABASE_URL.startswith("sqlite"):
    engine_options["connect_args"] = {"check_same_thread": False}

engine = create_engine(DATABASE_URL, **engine_options)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
