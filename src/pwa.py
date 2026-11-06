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
    "stellar.css": "text/css",
    "space-theme.css": "text/css",
    "workspace.css": "text/css",
    "workspace.js": "text/javascript",
    "navigation.js": "text/javascript",
    "sections.js": "text/javascript",
    "sections.css": "text/css",
    "reports.js": "text/javascript",
    "reports.css": "text/css",
    "sync.js": "text/javascript",
    "ranges.js": "text/javascript",
    "ranges.css": "text/css",
    "navigation.css": "text/css",
    "metrics.js": "text/javascript",
    "app.js": "text/javascript",
    "notifications.js": "text/javascript",
    "notifications.css": "text/css",
    "icon-192.png": "image/png",
    "icon-512.png": "image/png",
    "apple-touch-icon.png": "image/png",
    "stellar.svg": "image/svg+xml",
    "stellar-192.png": "image/png",
    "stellar-512.png": "image/png",
    "stellar-apple-touch-icon.png": "image/png",
}
LEGACY_ICONS = {
    "icon-192.png": "stellar-192.png",
    "icon-512.png": "stellar-512.png",
    "apple-touch-icon.png": "stellar-apple-touch-icon.png",
}
PUBLIC_PATHS = {"/manifest.webmanifest", "/sw.js", "/offline"} | {
    f"/app-assets/{name}" for name in ASSET_TYPES
}
router = APIRouter()

HEAD = """<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#FFFFFF">
<meta name="theme-color" content="#141414" media="(prefers-color-scheme: dark)">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="apple-mobile-web-app-title" content="Stellar">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/favicon.svg?v=stellar-1" type="image/svg+xml">
<link rel="apple-touch-icon" sizes="180x180" href="/app-assets/stellar-apple-touch-icon.png?v=2">
<script src="/app-assets/navigation.js?v=4"></script>
<script src="/app-assets/sections.js?v=1"></script>
<link rel="stylesheet" href="/app-assets/sections.css?v=1">
<script src="/app-assets/sync.js?v=1"></script>
<script src="/app-assets/reports.js?v=4"></script>
<link rel="stylesheet" href="/app-assets/reports.css?v=6">
<link rel="stylesheet" href="/app-assets/app.css?v=6">
<link rel="stylesheet" href="/app-assets/stellar.css?v=3">
<link rel="stylesheet" href="/app-assets/workspace.css?v=7">
<link rel="stylesheet" href="/app-assets/navigation.css?v=8">
<link rel="stylesheet" href="/app-assets/space-theme.css?v=1">
<script src="/app-assets/workspace.js?v=10" defer></script>
<script src="/app-assets/app.js?v=10" defer></script>"""

INSTALL_BUTTON = '<button type="button" class="install-button" aria-label="Install app" title="Install app" data-install hidden>Install app</button>'
INSTALL_DIALOG = """<dialog id="install-dialog" class="install-ui" aria-labelledby="install-title">
  <form method="dialog"><button class="install-close" aria-label="Close install instructions">×</button></form>
  <img src="/app-assets/stellar-192.png" width="64" height="64" alt="">
  <h2 id="install-title">Stellar on your phone</h2>
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
        "id": "/", "name": "Stellar", "short_name": "Stellar",
        "description": "Your daily tasks, weight, wake times, and progress.",
        "start_url": "/", "scope": "/", "display": "standalone", "lang": "en",
        "background_color": "#000000", "theme_color": "#000000",
        "icons": [
            {"src": f"/app-assets/stellar-{size}.png", "sizes": f"{size}x{size}",
             "type": "image/png", "purpose": "any maskable"}
            for size in (192, 512)
        ],
        "shortcuts": [
            {"name": "Space", "url": "/"},
            {"name": "Weight", "url": "/metrics?tab=weight"},
            {"name": "Wake time", "url": "/metrics?tab=wake"},
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
    return FileResponse(ASSETS / LEGACY_ICONS.get(name, name), media_type=ASSET_TYPES[name],
                        headers={"Cache-Control": "public, max-age=3600"})
