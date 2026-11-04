"""Public installation assets and a shared, standards-mode document shell.

Only the offline page and app artwork are cached on the phone. Authenticated
pages, API responses, and writes always use the network.
"""
from pathlib import Path
import re

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, JSONResponse, Response


ASSETS = Path(__file__).resolve().parent.parent / "scripts" / "static"
ASSET_TYPES = {
    "app.css": "text/css",
    "app.js": "text/javascript",
    "icon-192.png": "image/png",
    "icon-512.png": "image/png",
    "apple-touch-icon.png": "image/png",
}
PUBLIC_PATHS = {"/manifest.webmanifest", "/sw.js", "/offline"} | {
    f"/app-assets/{name}" for name in ASSET_TYPES
}
router = APIRouter()

HEAD = """<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#6D4AC4">
<meta name="theme-color" content="#1B1826" media="(prefers-color-scheme: dark)">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="apple-mobile-web-app-title" content="Task Tracker">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/app-assets/apple-touch-icon.png">
<link rel="stylesheet" href="/app-assets/app.css?v=1">
<script src="/app-assets/app.js?v=1" defer></script>"""

INSTALL_BUTTON = '<button type="button" class="install-button" data-install hidden>Install app</button>'
INSTALL_DIALOG = """<dialog id="install-dialog" class="install-ui" aria-labelledby="install-title">
  <form method="dialog"><button class="install-close" aria-label="Close install instructions">×</button></form>
  <img src="/app-assets/icon-192.png" width="64" height="64" alt="">
  <h2 id="install-title">Task Tracker on your phone</h2>
  <p>Keep your daily check-in a tap away. Open it from your home screen in its own window.</p>
  <div id="install-instructions"></div>
  <button type="button" id="install-native" hidden>Install app</button>
  <p id="install-feedback" role="status"></p>
</dialog>"""


def document(html: str, shell: str = "", extra_head: str = "") -> str:
    if re.search(r"<html\b", html, re.IGNORECASE):
        html = re.sub(r'<meta\s+[^>]*name=["\']viewport["\'][^>]*>', "", html, flags=re.IGNORECASE)
        html = html.replace("</head>", extra_head + HEAD + "</head>", 1)
        html = html.replace("<body>", "<body>" + shell, 1)
        return html.replace("</body>", INSTALL_DIALOG + "</body>", 1)
    pattern = r"<title>.*?</title>|<style>.*?</style>"
    head = "".join(re.findall(pattern, html, flags=re.DOTALL))
    body = re.sub(pattern, "", html, flags=re.DOTALL)
    return (f'<!doctype html><html lang="en"><head>{extra_head}{head}{HEAD}</head>'
            f"<body>{shell}{body}{INSTALL_DIALOG}</body></html>")


@router.get("/manifest.webmanifest", include_in_schema=False)
def manifest() -> JSONResponse:
    return JSONResponse({
        "id": "/", "name": "Task Tracker", "short_name": "Tasks",
        "description": "Your daily tasks, weight, wake times, and progress.",
        "start_url": "/", "scope": "/", "display": "standalone", "lang": "en",
        "background_color": "#EFEEF4", "theme_color": "#6D4AC4",
        "icons": [
            {"src": f"/app-assets/icon-{size}.png", "sizes": f"{size}x{size}",
             "type": "image/png", "purpose": "any maskable"}
            for size in (192, 512)
        ],
        "shortcuts": [
            {"name": "Daily check-in", "url": "/"},
            {"name": "Weight", "url": "/weight"},
            {"name": "Wake time", "url": "/wake"},
        ],
    }, media_type="application/manifest+json", headers={"Cache-Control": "no-cache"})


@router.get("/sw.js", include_in_schema=False)
def service_worker() -> FileResponse:
    return FileResponse(ASSETS / "sw.js", media_type="text/javascript",
                        headers={"Cache-Control": "no-cache", "Service-Worker-Allowed": "/"})


@router.get("/offline", include_in_schema=False)
def offline() -> Response:
    return Response((ASSETS / "offline.html").read_text(encoding="utf-8"),
                    media_type="text/html", headers={"Cache-Control": "no-cache"})


@router.get("/app-assets/{name}", include_in_schema=False)
def asset(name: str) -> FileResponse:
    if name not in ASSET_TYPES:
        raise HTTPException(404)
    return FileResponse(ASSETS / name, media_type=ASSET_TYPES[name],
                        headers={"Cache-Control": "public, max-age=3600"})
