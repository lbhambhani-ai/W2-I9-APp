from __future__ import annotations

from typing import Any

try:
    from fastapi import FastAPI, Header
    from pydantic import BaseModel, Field
except Exception as exc:  # pragma: no cover - import guard for setup clarity
    raise RuntimeError(
        "Install identity service dependencies with: pip install -r identity_service/requirements.txt"
    ) from exc

from identity_service.pipeline import verify_image_payload


class VerifyRequest(BaseModel):
    requestId: str
    imageBase64: str
    selectedDocumentType: str
    documentSide: str
    documentDetectedInFrame: bool | None = True
    profile: dict[str, Any] = Field(default_factory=dict)
    ocrText: str | None = None


app = FastAPI(title="Instawork Document Validation Service")


@app.get("/health")
def health() -> dict[str, bool]:
    return {"ok": True}


@app.post("/verify")
def verify_identity(
    payload: VerifyRequest,
    x_instawork_identity_secret: str | None = Header(default=None),
) -> dict[str, Any]:
    # The Express backend owns authentication. This header is accepted so the
    # service can be put behind a reverse proxy or checked in a later hardening pass.
    _ = x_instawork_identity_secret
    return verify_image_payload(payload.model_dump())
