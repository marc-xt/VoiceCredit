"""Vercel ASGI entrypoint for the VoiceCredit FastAPI application."""

from backend.app import app

__all__ = ["app"]
