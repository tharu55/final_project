"""Expose the FastAPI app for deployment commands that use ``demo:app``."""

from backend.main import app

__all__ = ["app"]
