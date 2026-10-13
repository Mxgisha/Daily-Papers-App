"""The ingestion pipeline for the Daily Papers App."""

from .pipeline import IngestResult, crawl

__all__ = ["IngestResult", "crawl"]
