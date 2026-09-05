#!/usr/bin/env python3
"""Local-only browser acceptance QA through the audited loopback CDP relay.

The Telegram session-renewal case uses a signed test fixture. It is not a
claim of real Telegram or VK authentication.
"""

import base64
import datetime as dt
import hashlib
import hmac
import html
import json
import os
import re
import sqlite3
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE_URL = os.environ.get("KOPILKA_QA_BASE_URL", "http://127.0.0.1:3119").rstrip("/")
CDP_URL = os.environ.get("KOPILKA_QA_CDP_URL", "http://127.0.0.1:18800")
DB_PATH = Path(os.environ.get("DB_PATH", "/tmp/kopilka-life-browser-qa.sqlite"))
BOT_TOKEN = os.environ.get("BOT_TOKEN", "test-bot-token")
SESSION_SECRET = os.environ.get("SESSION_SECRET", "browser-qa-session-secret")
VK_SECURE_KEY = os.environ.get("VK_SECURE_KEY", "browser-qa-vk-secure-key")
OAUTH_PROVIDER_URL = os.environ.get("KOPILKA_QA_OAUTH_PROVIDER_URL", "").rstrip("/")
OAUTH_VK_USER_ID = int(os.environ.get("KOPILKA_QA_OAUTH_VK_USER_ID", "770077"))


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def b64url(value):
    return base64.urlsafe_b64encode(value).decode().rstrip("=")


def expired_session_token(user_id):
    payload = json.dumps(
        {"v": 1, "userId": int(user_id), "iat": 1_700_000_000_000, "exp": 1_700_000_003_600},
        separators=(",", ":"),
    ).encode()
    encoded = b64url(payload)
    signature = b64url(hmac.new(SESSION_SECRET.encode(), encoded.encode(), hashlib.sha256).digest())
    return f"{encoded}.{signature}"


def telegram_init_data(user_id):
    now = int(time.time())
    user = json.dumps({"id": int(user_id), "first_name": "Renewal fixture", "language_code": "ru"}, separators=(",", ":"))
    values = {"auth_date": str(now), "query_id": "browser-renewal-fixture", "user": user}
    check = "\n".join(f"{key}={values[key]}" for key in sorted(values))
    secret = hmac.new(b"WebAppData", BOT_TOKEN.encode(), hashlib.sha256).digest()
    values["hash"] = hmac.new(secret, check.encode(), hashlib.sha256).hexdigest()
    return urllib.parse.urlencode(values)


def vk_launch_params(user_id):
    values = {
        "vk_app_id": "54723764",
        "vk_language": "ru",
        "vk_ts": str(int(time.time())),
        "vk_user_id": str(int(user_id)),
    }
    check = "&".join(f"{key}={values[key]}" for key in sorted(values))
    values["sign"] = b64url(hmac.new(VK_SECURE_KEY.encode(), check.encode(), hashlib.sha256).digest())
    return urllib.parse.urlencode(values)


def database_identity(user_id, column):
    require(column in {"telegram_id", "vk_id"}, "unsupported identity column")
    connection = sqlite3.connect(DB_PATH, timeout=10)
    try:
        return connection.execute(f"SELECT {column} FROM users WHERE id = ?", (int(user_id),)).fetchone()[0]
    finally:
        connection.close()


def database_entry_count(user_id, entry_type):
    connection = sqlite3.connect(DB_PATH, timeout=10)
    try:
        return connection.execute(
            "SELECT COUNT(*) FROM entries WHERE user_id = ? AND type = ?",
            (int(user_id), str(entry_type)),
        ).fetchone()[0]
    finally:
        connection.close()


def latest_link_proof_consumed(target_user_id):
    connection = sqlite3.connect(DB_PATH, timeout=10)
    try:
        row = connection.execute(
            "SELECT consumed_at FROM vk_oauth_link_proofs WHERE target_user_id = ? ORDER BY created_at DESC LIMIT 1",
            (int(target_user_id),),
        ).fetchone()
        return None if row is None else row[0]
    finally:
        connection.close()


def seed_oauth_merge_data(user_id):
    connection = sqlite3.connect(DB_PATH, timeout=10)
    try:
        connection.execute(
            "INSERT OR IGNORE INTO entries (user_id, type, title, note, life_points, entry_date) VALUES (?, 'joy', 'Радость', 'oauth merge fixture', 1, '2026-09-05')",
            (int(user_id),),
        )
        connection.commit()
    finally:
        connection.close()


class OAuthStandIn:
    def __init__(self, provider_url):
        parsed = urllib.parse.urlparse(provider_url)
        require(parsed.scheme == "http" and parsed.hostname in {"localhost", "127.0.0.1"} and parsed.port, "OAuth stand-in must use an explicit loopback HTTP URL")
        self.provider_url = provider_url
        self.authorize_gate = threading.Event()
        self.authorize_seen = threading.Event()
        self.requests = []
        self.user_id = OAUTH_VK_USER_ID
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, format, *args):
                _ = (format, args)
                return

            def send_body(self, status, body, content_type="text/html; charset=utf-8", headers=None):
                encoded = body.encode()
                self.send_response(status)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(encoded)))
                self.send_header("Cache-Control", "no-store")
                for key, value in (headers or {}).items():
                    self.send_header(key, value)
                self.end_headers()
                self.wfile.write(encoded)

            def do_GET(self):
                parsed_request = urllib.parse.urlparse(self.path)
                params = urllib.parse.parse_qs(parsed_request.query)
                if parsed_request.path == "/frame":
                    app_url = params.get("app", [""])[0]
                    body = f'''<!doctype html><html><body><h1>Cross-site VK host fixture</h1><iframe id="vk-frame" title="VK Mini App fixture" src="{html.escape(app_url, quote=True)}"></iframe><script>window.oauthMessages=[]; window.addEventListener('message', event => window.oauthMessages.push({{origin:event.origin,type:event.data?.type,hasToken:Boolean(event.data?.token)}}));</script></body></html>'''
                    self.send_body(200, body)
                    return
                if parsed_request.path == "/authorize":
                    owner.requests.append(("authorize", params))
                    owner.authorize_seen.set()
                    owner.authorize_gate.wait(timeout=30)
                    redirect_uri = params.get("redirect_uri", [""])[0]
                    state = params.get("state", [""])[0]
                    target = f"{redirect_uri}?{urllib.parse.urlencode({'code': 'local-provider-code', 'device_id': 'local-device', 'state': state})}"
                    self.send_body(303, "", headers={"Location": target})
                    return
                self.send_body(404, "not found", "text/plain; charset=utf-8")

            def do_POST(self):
                parsed_request = urllib.parse.urlparse(self.path)
                length = int(self.headers.get("content-length", "0"))
                fields = urllib.parse.parse_qs(self.rfile.read(length).decode())
                if parsed_request.path == "/token":
                    owner.requests.append(("token", fields))
                    body = json.dumps({"user_id": owner.user_id, "access_token": "local-provider-access-token"})
                    self.send_body(200, body, "application/json")
                    return
                self.send_body(404, "not found", "text/plain; charset=utf-8")

        port = parsed.port
        assert port is not None
        self.server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *_args):
        self.authorize_gate.set()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=3)


def wait_ready(page):
    page.locator("#appShell").wait_for(state="visible", timeout=20_000)
    page.locator("#tab-button-today").wait_for(state="visible", timeout=20_000)
    page.wait_for_function("document.querySelector('#totalLife') && document.querySelector('#historyDate')?.value")


def seed_prior_rest_entries(user_id, selected_date):
    selected = dt.date.fromisoformat(selected_date)
    connection = sqlite3.connect(DB_PATH, timeout=10)
    try:
        for offset in (1, 2, 3):
            entry_date = (selected - dt.timedelta(days=offset)).isoformat()
            connection.execute(
                "INSERT OR IGNORE INTO entries (user_id, type, title, note, life_points, entry_date) VALUES (?, 'rest', 'Отдых', '', 2, ?)",
                (user_id, entry_date),
            )
        connection.commit()
    finally:
        connection.close()

def make_contract_last_day(user_id, selected_date):
    connection = sqlite3.connect(DB_PATH, timeout=10)
    try:
        changed = connection.execute(
            "UPDATE weekly_contracts SET week_end = ? WHERE user_id = ? AND status = 'active'",
            (selected_date, user_id),
        ).rowcount
        connection.commit()
        require(changed == 1, "browser fixture must update exactly one active contract")
    finally:
        connection.close()


def run():
    require(OAUTH_PROVIDER_URL, "KOPILKA_QA_OAUTH_PROVIDER_URL is required for the cross-site OAuth regression")
    evidence = []
    errors = []
    with OAuthStandIn(OAUTH_PROVIDER_URL) as oauth_provider, sync_playwright() as playwright:
        browser = playwright.chromium.connect_over_cdp(CDP_URL)
        # Local fixtures do not need the authenticated profile. Isolate their
        # storage and dialogs from concurrent clients on the shared CDP rail.
        context = browser.new_context()
        for existing_page in list(context.pages):
            if existing_page.url.startswith(BASE_URL) or existing_page.url.startswith(OAUTH_PROVIDER_URL):
                existing_page.close()
        page = context.new_page()
        renewal_page = None
        stale_page = None
        telegram_page = None
        vk_page = None
        host_page = None
        mismatch_page = None
        link_page = None
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.on("console", lambda message: errors.append(message.text) if message.type == "error" else None)
        unexpected_unauthorized = []
        page.on("response", lambda response: unexpected_unauthorized.append(response.url) if response.status == 401 else None)
        try:
            page.set_viewport_size({"width": 390, "height": 844})
            page.add_init_script("""
              if (!sessionStorage.getItem('kopilkaQaStoragePrepared')) {
                localStorage.removeItem('kopilkaToken');
                sessionStorage.setItem('kopilkaQaStoragePrepared', '1');
              }
            """)
            page.goto(BASE_URL, wait_until="domcontentloaded")
            page.locator("#loginScreen").wait_for(state="visible", timeout=20_000)
            require(not unexpected_unauthorized, f"fresh initial state made unexpected 401 requests: {unexpected_unauthorized}")
            login_semantics = page.locator("#vkLoginButton").evaluate(
                "element => ({tag: element.tagName, type: element.type, tabIndex: element.tabIndex, label: element.innerText.trim()})"
            )
            require(login_semantics["tag"] == "BUTTON" and login_semantics["type"] == "button" and login_semantics["tabIndex"] == 0, "VK login must be a native keyboard-focusable button")
            evidence.append(["vk-login-semantics", login_semantics])

            stale_auth_response = context.request.post(
                f"{BASE_URL}/api/auth/dev",
                data={"firstName": "Stale token fixture", "locale": "ru", "timezone": "UTC"},
            )
            require(stale_auth_response.ok, "stale-token fixture auth failed")
            stale_user_id = stale_auth_response.json()["user"]["id"]
            stale_page = context.new_page()
            stale_errors = []
            stale_unauthorized = []
            stale_page.on("pageerror", lambda error: stale_errors.append(str(error)))
            stale_page.on("console", lambda message: stale_errors.append(message.text) if message.type == "error" else None)
            stale_page.on("response", lambda response: stale_unauthorized.append(urllib.parse.urlparse(response.url).path) if response.status == 401 else None)
            stale_page.add_init_script(f"localStorage.setItem('kopilkaToken', {json.dumps(expired_session_token(stale_user_id))});")
            stale_page.goto(BASE_URL, wait_until="domcontentloaded")
            stale_page.locator("#loginScreen").wait_for(state="visible", timeout=20_000)
            require(stale_page.evaluate("localStorage.getItem('kopilkaToken')") is None, "initial stale token must be cleared after rejected renewal")
            require(stale_unauthorized == ["/api/me"], f"initial stale-token fixture had unexpected 401 responses: {stale_unauthorized}")
            expected_stale_console = ['Failed to load resource: the server responded with a status of 401 (Unauthorized)']
            require(stale_errors == expected_stale_console, f"initial stale-token fixture had unexpected console/page errors: {stale_errors}")
            stale_page.close()
            stale_page = None
            evidence.append(["fresh-and-stale-initial-token", "passed"])

            cached_a = context.request.post(
                f"{BASE_URL}/api/auth/dev",
                data={"firstName": "Cached account A", "locale": "ru", "timezone": "UTC"},
            ).json()
            telegram_b_id = 990201
            telegram_b_data = telegram_init_data(telegram_b_id)
            priority_tg_page = context.new_page()
            priority_tg_private = []
            priority_tg_page.on(
                "request",
                lambda request: priority_tg_private.append((urllib.parse.urlparse(request.url).path, request.headers.get("authorization")))
                if urllib.parse.urlparse(request.url).path.startswith("/api/")
                and not urllib.parse.urlparse(request.url).path.startswith("/api/auth/")
                and request.headers.get("authorization")
                else None,
            )
            priority_tg_page.route("https://telegram.org/js/telegram-web-app.js", lambda route: route.fulfill(status=200, content_type="application/javascript", body="/* isolated local Telegram fixture */"))
            priority_tg_page.add_init_script(f"localStorage.setItem('kopilkaToken',{json.dumps(cached_a['token'])}); window.Telegram={{WebApp:{{initData:{json.dumps(telegram_b_data)},initDataUnsafe:{{}},ready(){{}},expand(){{}}}}}};")
            priority_tg_page.goto(BASE_URL, wait_until="domcontentloaded")
            wait_ready(priority_tg_page)
            priority_tg_token = priority_tg_page.evaluate("localStorage.getItem('kopilkaToken')")
            priority_tg_user = priority_tg_page.evaluate("state.user.id")
            require(priority_tg_user != cached_a["user"]["id"] and str(database_identity(priority_tg_user, "telegram_id")) == str(telegram_b_id), "cached account A won over current signed Telegram user B")
            require(priority_tg_private and all(token == f"Bearer {priority_tg_token}" for _path, token in priority_tg_private), f"Telegram B launch made private reads with cached A token: {priority_tg_private}")
            priority_tg_page.locator('[data-entry-type="food_water"]').click()
            for _ in range(50):
                if database_entry_count(priority_tg_user, "food_water"):
                    break
                priority_tg_page.wait_for_timeout(100)
            require(database_entry_count(priority_tg_user, "food_water") == 1 and database_entry_count(cached_a["user"]["id"], "food_water") == 0, "Telegram B write was applied to cached account A")
            priority_tg_page.close()

            vk_b_id = 880188
            priority_vk_page = context.new_page()
            priority_vk_private = []
            priority_vk_page.on(
                "request",
                lambda request: priority_vk_private.append((urllib.parse.urlparse(request.url).path, request.headers.get("authorization")))
                if urllib.parse.urlparse(request.url).path.startswith("/api/")
                and not urllib.parse.urlparse(request.url).path.startswith("/api/auth/")
                and request.headers.get("authorization")
                else None,
            )
            priority_vk_page.add_init_script(f"localStorage.setItem('kopilkaToken',{json.dumps(cached_a['token'])});")
            priority_vk_page.goto(f"{BASE_URL}/?{vk_launch_params(vk_b_id)}", wait_until="domcontentloaded")
            wait_ready(priority_vk_page)
            priority_vk_token = priority_vk_page.evaluate("localStorage.getItem('kopilkaToken')")
            priority_vk_user = priority_vk_page.evaluate("state.user.id")
            require(priority_vk_user != cached_a["user"]["id"] and str(database_identity(priority_vk_user, "vk_id")) == str(vk_b_id), "cached account A won over current signed VK user B")
            require(priority_vk_private and all(token == f"Bearer {priority_vk_token}" for _path, token in priority_vk_private), f"VK B launch made private reads with cached A token: {priority_vk_private}")
            priority_vk_page.locator('[data-entry-type="movement"]').click()
            for _ in range(50):
                if database_entry_count(priority_vk_user, "movement"):
                    break
                priority_vk_page.wait_for_timeout(100)
            require(database_entry_count(priority_vk_user, "movement") == 1 and database_entry_count(cached_a["user"]["id"], "movement") == 0, "VK B write was applied to cached account A")
            priority_vk_page.close()

            bridge_vk_id = 880189
            bridge_params = {key: values[0] for key, values in urllib.parse.parse_qs(vk_launch_params(bridge_vk_id)).items()}
            bridge_vk_page = context.new_page()
            bridge_private = []
            bridge_vk_page.on(
                "request",
                lambda request: bridge_private.append((urllib.parse.urlparse(request.url).path, request.headers.get("authorization")))
                if urllib.parse.urlparse(request.url).path.startswith("/api/")
                and not urllib.parse.urlparse(request.url).path.startswith("/api/auth/")
                and request.headers.get("authorization")
                else None,
            )
            bridge_vk_page.route(f"{BASE_URL}/vendor/vk-bridge-3.0.2.min.js*", lambda route: route.fulfill(status=200, content_type="application/javascript", body="/* preserve injected Bridge fixture */"))
            bridge_vk_page.add_init_script(f"localStorage.setItem('kopilkaToken',{json.dumps(cached_a['token'])}); window.vkBridge={{send(method){{return Promise.resolve(method==='VKWebAppGetLaunchParams'?{json.dumps(bridge_params)}:{{}});}}}};")
            bridge_vk_page.goto(BASE_URL, wait_until="domcontentloaded")
            wait_ready(bridge_vk_page)
            bridge_token = bridge_vk_page.evaluate("localStorage.getItem('kopilkaToken')")
            bridge_user = bridge_vk_page.evaluate("state.user.id")
            require(bridge_user != cached_a["user"]["id"] and str(database_identity(bridge_user, "vk_id")) == str(bridge_vk_id), "cached account A won over current verified VK Bridge user B")
            require(bridge_private and all(token == f"Bearer {bridge_token}" for _path, token in bridge_private), f"VK Bridge B launch made private reads with cached A token: {bridge_private}")
            bridge_vk_page.close()

            delayed_tg_id = 990202
            delayed_tg_data = telegram_init_data(delayed_tg_id)
            delayed_tg_page = context.new_page()
            delayed_private = []
            delayed_tg_page.on(
                "request",
                lambda request: delayed_private.append((urllib.parse.urlparse(request.url).path, request.headers.get("authorization")))
                if urllib.parse.urlparse(request.url).path.startswith("/api/")
                and not urllib.parse.urlparse(request.url).path.startswith("/api/auth/")
                and request.headers.get("authorization")
                else None,
            )
            delayed_script = f"setTimeout(()=>{{window.Telegram={{WebApp:{{initData:{json.dumps(delayed_tg_data)},initDataUnsafe:{{}},ready(){{}},expand(){{}}}}}};}},500);"
            delayed_tg_page.route("https://telegram.org/js/telegram-web-app.js", lambda route: route.fulfill(status=200, content_type="application/javascript", body=delayed_script))
            delayed_tg_page.add_init_script(f"localStorage.setItem('kopilkaToken',{json.dumps(cached_a['token'])}); window.__kopilkaLoginSeen=false; const watch=setInterval(()=>{{const el=document.getElementById('loginScreen'); if(el && !el.hidden) window.__kopilkaLoginSeen=true;}},10); setTimeout(()=>clearInterval(watch),3000);")
            delayed_tg_page.goto(f"{BASE_URL}/?tgWebAppData=delayed-fixture", wait_until="domcontentloaded")
            wait_ready(delayed_tg_page)
            delayed_token = delayed_tg_page.evaluate("localStorage.getItem('kopilkaToken')")
            delayed_user = delayed_tg_page.evaluate("state.user.id")
            require(str(database_identity(delayed_user, "telegram_id")) == str(delayed_tg_id), "late Telegram SDK did not replace cached account A with signed user B")
            require(delayed_private and all(token == f"Bearer {delayed_token}" for _path, token in delayed_private), f"late Telegram SDK allowed cached A private reads: {delayed_private}")
            require(not delayed_tg_page.evaluate("window.__kopilkaLoginSeen"), "late genuine Telegram launch briefly showed website login")
            delayed_tg_page.close()
            evidence.append(["cached-token-platform-priority", "Telegram A→B reads+writes", "VK signed/Bridge A→B reads+writes", "delayed Telegram SDK", "passed"])

            telegram_user_id = 990101
            telegram_data = telegram_init_data(telegram_user_id)
            telegram_page = context.new_page()
            telegram_page.route("https://telegram.org/js/telegram-web-app.js", lambda route: route.fulfill(status=200, content_type="application/javascript", body="/* isolated local Telegram fixture */"))
            telegram_page.add_init_script(f"""
              if (!sessionStorage.getItem('kopilkaQaPlatformPrepared')) {{ localStorage.removeItem('kopilkaToken'); sessionStorage.setItem('kopilkaQaPlatformPrepared', '1'); }}
              window.Telegram={{WebApp:{{initData:{json.dumps(telegram_data)},initDataUnsafe:{{}},ready(){{}},expand(){{}}}}}};
            """)
            telegram_page.goto(BASE_URL, wait_until="domcontentloaded")
            wait_ready(telegram_page)
            require(not telegram_page.locator("#loginScreen").is_visible(), "normal signed Telegram fresh launch must not show login UI")
            telegram_internal_id = telegram_page.evaluate("fetch('/api/me',{headers:{authorization:`Bearer ${localStorage.getItem('kopilkaToken')}`}}).then(r=>r.json()).then(x=>x.user.id)")
            require(str(database_identity(telegram_internal_id, "telegram_id")) == str(telegram_user_id), "normal Telegram launch authenticated the wrong identity")
            telegram_fresh_token = telegram_page.evaluate("localStorage.getItem('kopilkaToken')")
            telegram_page.evaluate("token => { state.token=token; localStorage.setItem('kopilkaToken',token); }", expired_session_token(telegram_internal_id))
            telegram_page.reload(wait_until="domcontentloaded")
            wait_ready(telegram_page)
            require(telegram_page.evaluate("localStorage.getItem('kopilkaToken')") not in {None, telegram_fresh_token, expired_session_token(telegram_internal_id)}, "expired Telegram app session was not transparently renewed from signed initData")
            require(not telegram_page.locator("#loginScreen").is_visible() and str(database_identity(telegram_internal_id, "telegram_id")) == str(telegram_user_id), "Telegram renewal changed identity or showed login UI")
            telegram_page.close()
            telegram_page = None

            vk_user_id = 880088
            signed_vk = vk_launch_params(vk_user_id)
            vk_page = context.new_page()
            vk_oauth_requests = []
            vk_page.on("request", lambda request: vk_oauth_requests.append(request.url) if "/api/auth/vk-oauth/" in request.url else None)
            vk_page.add_init_script("if (!sessionStorage.getItem('kopilkaQaPlatformPrepared')) { localStorage.removeItem('kopilkaToken'); sessionStorage.setItem('kopilkaQaPlatformPrepared','1'); }")
            vk_page.goto(f"{BASE_URL}/?{signed_vk}", wait_until="domcontentloaded")
            wait_ready(vk_page)
            require(not vk_page.locator("#loginScreen").is_visible(), "normal signed VK fresh launch must not show login UI")
            vk_internal_id = vk_page.evaluate("fetch('/api/me',{headers:{authorization:`Bearer ${localStorage.getItem('kopilkaToken')}`}}).then(r=>r.json()).then(x=>x.user.id)")
            require(str(database_identity(vk_internal_id, "vk_id")) == str(vk_user_id), "normal signed VK launch authenticated the wrong identity")
            require(not vk_oauth_requests, f"normal signed VK launch must not enter OAuth fallback: {vk_oauth_requests}")
            vk_fresh_token = vk_page.evaluate("localStorage.getItem('kopilkaToken')")
            vk_page.evaluate("token => { state.token=token; localStorage.setItem('kopilkaToken',token); }", expired_session_token(vk_internal_id))
            vk_page.reload(wait_until="domcontentloaded")
            wait_ready(vk_page)
            require(vk_page.evaluate("localStorage.getItem('kopilkaToken')") not in {None, vk_fresh_token, expired_session_token(vk_internal_id)}, "expired VK app session was not transparently renewed from signed launch proof")
            require(not vk_page.locator("#loginScreen").is_visible() and str(database_identity(vk_internal_id, "vk_id")) == str(vk_user_id), "VK renewal changed identity or showed login UI")
            require(not vk_oauth_requests, f"valid VK renewal must not enter OAuth fallback: {vk_oauth_requests}")
            vk_page.close()
            vk_page = None
            evidence.append(["normal-platform-auth", "Telegram fresh+expired", "VK fresh+expired", "correct identity", "passed"])

            auth_response = context.request.post(
                f"{BASE_URL}/api/auth/dev",
                data={"firstName": "Browser audit", "locale": "ru", "timezone": "Europe/Moscow"},
            )
            require(auth_response.ok, "dev auth fixture failed")
            auth = auth_response.json()
            user_id = auth["user"]["id"]
            page.evaluate("token => localStorage.setItem('kopilkaToken', token)", auth["token"])
            page.reload(wait_until="domcontentloaded")
            wait_ready(page)

            positions = page.evaluate("""() => ({
              actions: document.querySelector('#quickActions').getBoundingClientRect().top,
              hint: document.querySelector('#dailyHintHeading').getBoundingClientRect().top,
              nav: (() => { const n=document.querySelector('.tab-bar'); const r=n.getBoundingClientRect(); return {left:r.left,right:r.right,width:r.width,scrollWidth:n.scrollWidth,clientWidth:n.clientWidth,rows:[...new Set([...n.querySelectorAll('button')].map(b=>Math.round(b.getBoundingClientRect().top)))]}; })()
            })""")
            require(positions["actions"] < positions["hint"], "mobile quick actions must appear before the detailed daily hint")
            require(positions["nav"]["scrollWidth"] <= positions["nav"]["clientWidth"] + 1 and len(positions["nav"]["rows"]) == 2, "six mobile tabs must fit in two rows without horizontal overflow")
            evidence.append(["mobile-layout", positions])

            tab_names = ["today", "week", "contract", "settings", "support", "profile"]
            for tab in tab_names:
                page.locator(f"#tab-button-{tab}").click()
                require(page.locator(f"#tab-{tab}").is_visible(), f"{tab} panel did not become visible")
                require(page.locator(f"#tab-button-{tab}").get_attribute("aria-selected") == "true", f"{tab} tab was not selected accessibly")
                require(page.evaluate(f"document.activeElement === document.querySelector('#heading-{tab}')"), f"{tab} heading did not receive focus")
            evidence.append(["six-tabs-mobile", "passed"])

            page.locator("#tab-button-today").click()
            sleep_button = page.locator('[data-entry-type="sleep"]')
            sleep_button.click()
            page.wait_for_function("document.querySelector('[data-entry-type=\"sleep\"]').dataset.usedToday === 'true'")
            page.locator('[data-entry-type="joy"]').click()
            page.wait_for_function("document.querySelector('[data-entry-type=\"joy\"]').dataset.usedToday === 'true'")

            page.locator("#tab-button-week").click()
            selected_date = page.locator("#historyDate").input_value()
            require(page.locator("#historyDate").get_attribute("type") == "date", "history must use a native date input")
            page.locator("#historyPrevious").click()
            page.wait_for_function(f"document.querySelector('#historyDate').value !== {json.dumps(selected_date)}")
            require(page.locator("#historyDate").input_value() != selected_date, "previous-day history navigation failed")
            require("За текущую неделю" in page.locator("#tab-week").inner_text(), "past-day History view must label independent totals as the current week")
            page.locator("#historyToday").click()
            page.wait_for_function(f"document.querySelector('#historyDate').value === {json.dumps(selected_date)}")
            require(page.locator("#historyDate").input_value() == selected_date, "today history navigation failed")
            edit_button = page.locator("[data-history-edit]").first
            entry_id = edit_button.get_attribute("data-history-edit")
            edit_button.click()
            page.locator(f"#history-note-{entry_id}").fill("Исправленная заметка из браузерной проверки")
            page.locator(f'[data-history-edit-form="{entry_id}"]').evaluate("form => form.requestSubmit()")
            page.wait_for_function("document.querySelector('#statusRegion').textContent.includes('исправлена')")
            require("Исправленная заметка" in page.locator("#selectedDayEntries").inner_text(), "edited history note was not rendered")
            page.once("dialog", lambda dialog: dialog.accept())
            page.locator(f'[data-history-delete="{entry_id}"]').click()
            page.wait_for_function("document.querySelector('#statusRegion').textContent.includes('удалена')")
            require("Исправленная заметка" not in page.locator("#selectedDayEntries").inner_text(), "deleted daily entry remained in history")
            evidence.append(["history-edit-delete", selected_date, "passed"])

            page.locator("#tab-button-profile").click()
            page.evaluate("""() => {
              const denied = { writeText: () => Promise.reject(Object.assign(new Error('fixture denied'), {name:'NotAllowedError'})) };
              try { Object.defineProperty(navigator, 'clipboard', {value: denied, configurable: true}); }
              catch (_) { navigator.clipboard.writeText = denied.writeText; }
            }""")
            page.locator("#copyRefLink").click()
            page.locator("#shareFallback").wait_for(state="visible")
            fallback_value = page.locator("#shareFallbackLink").input_value()
            require(fallback_value.startswith("http"), "clipboard failure must expose a manual fallback link")
            require("скопирована" not in page.locator("#statusRegion").inner_text().lower(), "clipboard failure must not claim success")
            require(page.evaluate("""() => { const i=document.querySelector('#shareFallbackLink'); return document.activeElement===i && i.selectionStart===0 && i.selectionEnd===i.value.length; }"""), "manual fallback link must be focused and selected")
            evidence.append(["clipboard-failure-fallback", "passed"])

            page.locator("#tab-button-settings").click()
            page.locator("#lang-en").click()
            page.wait_for_function("document.querySelector('#tab-button-week').textContent.trim() === 'History'")
            page.locator("#tab-button-profile").click()
            artifact_text_en = page.locator("#artifactsGrid").inner_text()
            require(not re.search(r"[А-Яа-яЁё]", artifact_text_en), "English artifact cards must not contain Russian copy")
            page.locator("#tab-button-settings").click()
            page.locator("#lang-ru").click()
            page.wait_for_function("document.querySelector('#tab-button-week').textContent.trim() === 'История'")
            evidence.append(["ru-en-artifacts", "passed"])

            seed_prior_rest_entries(user_id, selected_date)
            page.locator("#tab-button-contract").click()
            page.locator("#contractTitle").fill("QA договор последнего дня")
            page.locator("#contractTarget").fill("Один спокойный шаг")
            page.locator("#stakeAmount").fill("0")
            page.locator("#stakeCurrency").fill("RUB")
            page.locator("#rewardDescription").fill("Чай")
            page.locator("#fundDescription").fill("Без перевода")
            page.locator("#contractForm").evaluate("form => form.requestSubmit()")
            page.wait_for_function("document.querySelector('#contractCurrent').textContent.includes('QA договор последнего дня')")
            make_contract_last_day(user_id, selected_date)
            page.reload(wait_until="domcontentloaded")
            wait_ready(page)
            page.locator("#tab-button-contract").click()
            page.locator('[data-close-status="completed"]').click()
            page.locator("#artifactToast").wait_for(state="visible", timeout=10_000)
            first_award = page.locator("#artifactToastTitle").inner_text()
            require(page.evaluate("document.querySelector('#main').hasAttribute('inert') && document.activeElement === document.querySelector('#artifactToastClose')"), "award modal must isolate background and focus close")
            page.locator("#artifactToastClose").click()
            require(page.locator("#artifactToast").is_visible(), "second newly awarded character must remain in the accessible queue")
            second_award = page.locator("#artifactToastTitle").inner_text()
            require(second_award != first_award, "award queue must advance to a distinct character")
            page.locator("#artifactToastClose").click()
            require(not page.locator("#artifactToast").is_visible(), "award modal must close after the queue")
            require(page.evaluate("!document.querySelector('#main').hasAttribute('inert') && document.activeElement === document.querySelector('#tab-button-contract')"), "award modal must restore a useful focus target")
            evidence.append(["last-day-contract-multiple-awards", first_award, second_award])

            page.set_viewport_size({"width": 1024, "height": 900})
            desktop_nav = page.locator(".tab-bar").evaluate("""n => ({scrollWidth:n.scrollWidth,clientWidth:n.clientWidth,rows:[...new Set([...n.querySelectorAll('button')].map(b=>Math.round(b.getBoundingClientRect().top)))]})""")
            require(desktop_nav["scrollWidth"] <= desktop_nav["clientWidth"] + 1 and len(desktop_nav["rows"]) == 1, "desktop tabs must fit on one row")
            evidence.append(["desktop-nav", desktop_nav])

            require(not errors, f"browser had console/page errors before the intentional 401 recovery fixture: {errors}")
            recovery_unauthorized = []
            vk_auth_attempts = []
            page.on("response", lambda response: recovery_unauthorized.append(urllib.parse.urlparse(response.url).path) if response.status == 401 else None)
            page.route("**/api/auth/vk", lambda route: (vk_auth_attempts.append(route.request.url), route.fulfill(status=401, content_type="application/json", body='{"error":"fixture rejected","code":"AUTH_INVALID"}')))
            page.evaluate("""token => {
              history.replaceState({}, document.title, '/?vk_app_id=54723764&vk_user_id=1&sign=fixture');
              window.vkBridge = {send(method) { return method === 'VKWebAppGetLaunchParams' ? Promise.reject(new Error('fixture bridge rejected')) : Promise.resolve({}); }};
              state.token = token;
              localStorage.setItem('kopilkaToken', token);
              document.querySelector('#entryNote').value = 'Несохранённая заметка должна остаться';
            }""", expired_session_token(user_id))
            page.locator("#tab-button-today").click()
            page.locator('[data-entry-type="movement"]').click()
            page.locator("#loginScreen").wait_for(state="visible", timeout=20_000)
            require(page.locator("#vkLoginButton").is_visible() and page.locator("#vkLoginButton").is_enabled(), "failed VK renewal must expose a usable VK OAuth fallback button")
            require(page.locator("#loginRecoveryHint").is_visible(), "failed platform renewal must explain the recovery action")
            require(page.locator("#entryNote").input_value() == "Несохранённая заметка должна остаться", "session recovery must preserve unsaved input")
            require(len(vk_auth_attempts) == 1, f"automatic VK renewal must be bounded to one backend attempt, got {len(vk_auth_attempts)}")
            page.evaluate("api('/api/summary/today').catch(() => {})")
            page.wait_for_timeout(100)
            require(len(vk_auth_attempts) == 1, "failed automatic renewal must not loop on later API failures")
            expected_recovery_401 = ["/api/entries", "/api/auth/vk", "/api/summary/today"]
            require(recovery_unauthorized == expected_recovery_401, f"active recovery had unexpected 401 responses: {recovery_unauthorized}")
            expected_recovery_console = ['Failed to load resource: the server responded with a status of 401 (Unauthorized)'] * len(expected_recovery_401)
            require(errors == expected_recovery_console, f"active recovery had unexpected console/page errors: {errors}")
            errors.clear()
            evidence.append(["active-action-vk-renewal-recovery", "passed"])

            context.clear_cookies(name="kopilka_oauth_browser")
            host_page = context.new_page()
            host_page.add_init_script(f"if (location.origin === {json.dumps(BASE_URL)} && !sessionStorage.getItem('kopilkaQaCrossSitePrepared')) {{ localStorage.removeItem('kopilkaToken'); sessionStorage.setItem('kopilkaQaCrossSitePrepared','1'); }}")
            cdp = context.new_cdp_session(host_page)
            cdp.send("Network.enable")
            cdp.send("Network.setCookieControls", {
                "enableThirdPartyCookieRestriction": True,
                "disableThirdPartyCookieMetadata": True,
                "disableThirdPartyCookieHeuristics": True,
            })
            embedded_vk_user_id = 880099
            embedded_vk_url = f"{BASE_URL}/?{vk_launch_params(embedded_vk_user_id)}"
            host_page.goto(f"{OAUTH_PROVIDER_URL}/frame?{urllib.parse.urlencode({'app': embedded_vk_url})}", wait_until="domcontentloaded")
            host_page.wait_for_timeout(300)
            vk_frame = next((frame for frame in host_page.frames if frame.url.startswith(f"{BASE_URL}/")), None)
            require(vk_frame is not None, f"signed cross-site VK iframe fixture did not load: {[frame.url for frame in host_page.frames]}")
            assert vk_frame is not None
            wait_ready(vk_frame)
            require(not vk_frame.locator("#loginScreen").is_visible(), "normal signed cross-site VK launch must authenticate immediately without login UI")
            embedded_internal_id = vk_frame.evaluate("fetch('/api/me',{headers:{authorization:`Bearer ${localStorage.getItem('kopilkaToken')}`}}).then(r=>r.json()).then(x=>x.user.id)")
            require(str(database_identity(embedded_internal_id, "vk_id")) == str(embedded_vk_user_id), "signed cross-site VK launch authenticated the wrong identity")
            vk_frame.evaluate("token => { state.token=token; localStorage.setItem('kopilkaToken',token); }", expired_session_token(embedded_internal_id))
            vk_frame.goto(embedded_vk_url, wait_until="domcontentloaded")
            wait_ready(vk_frame)
            require(not vk_frame.locator("#loginScreen").is_visible() and str(database_identity(embedded_internal_id, "vk_id")) == str(embedded_vk_user_id), "signed cross-site VK renewal changed identity or showed login UI")
            require(not oauth_provider.requests, "normal signed cross-site VK launch entered OAuth fallback")
            vk_frame.evaluate("localStorage.removeItem('kopilkaToken')")

            invalid_vk_url = f"{BASE_URL}/?vk_app_id=54723764&vk_user_id=1&vk_ts={int(time.time())}&sign=invalid"
            host_page.goto(f"{OAUTH_PROVIDER_URL}/frame?{urllib.parse.urlencode({'app': invalid_vk_url})}", wait_until="domcontentloaded")
            host_page.wait_for_timeout(300)
            vk_frame = next((frame for frame in host_page.frames if frame.url.startswith(f"{BASE_URL}/")), None)
            require(vk_frame is not None, f"cross-site VK iframe fixture did not load: {[frame.url for frame in host_page.frames]}")
            assert vk_frame is not None
            vk_frame.locator("#loginScreen").wait_for(state="visible", timeout=20_000)
            require(vk_frame.locator("#vkLoginButton").is_visible(), "invalid VK proof must expose explicit OAuth recovery instead of starting it automatically")
            require(not oauth_provider.requests, "invalid VK proof must not silently start OAuth")
            vk_frame.evaluate("fetch('/api/auth/vk-oauth/window').then(r=>r.text())")
            third_party_cookies = [cookie for cookie in context.cookies(BASE_URL) if cookie.get("name") == "kopilka_oauth_browser"]
            require(not third_party_cookies, "third-party iframe fetch unexpectedly established the Lax OAuth browser cookie")

            host_page.evaluate("origin => document.querySelector('#vk-frame').contentWindow.postMessage({type:'kopilka:vk-oauth',channel:'foreign',token:'forged'}, origin)", urllib.parse.urlparse(BASE_URL).scheme + "://" + urllib.parse.urlparse(BASE_URL).netloc)
            require(vk_frame.evaluate("localStorage.getItem('kopilkaToken')") is None, "foreign-origin handoff message was accepted")

            opened_popups = []
            host_page.on("popup", lambda popup: opened_popups.append(popup))
            vk_frame.locator("#vkLoginButton").click()
            for _ in range(50):
                if oauth_provider.authorize_seen.is_set() or vk_frame.locator("#loginStatus a").count():
                    break
                vk_frame.wait_for_timeout(100)
            popup_opened = oauth_provider.authorize_seen.is_set()
            fallback_href = None if popup_opened else vk_frame.locator("#loginStatus a").get_attribute("href")
            require(popup_opened or fallback_href, "VK OAuth exposed neither a first-party popup nor the popup-blocked first-party link")
            oauth_popup = opened_popups[-1] if opened_popups else None
            channel = vk_frame.evaluate("state.vkOAuthChannel")
            require(channel, "initiating iframe did not retain the server-issued OAuth handoff channel")

            host_page.evaluate("app => { const frame=document.createElement('iframe'); frame.id='mismatch-frame'; frame.src=app+'/?qa=mismatched-source'; document.body.appendChild(frame); }", BASE_URL)
            mismatch_frame = None
            for _ in range(50):
                mismatch_frame = next((frame for frame in host_page.frames if 'qa=mismatched-source' in frame.url), None)
                if mismatch_frame is not None:
                    break
                host_page.wait_for_timeout(100)
            require(mismatch_frame is not None, "mismatched same-origin source fixture did not load")
            assert mismatch_frame is not None
            mismatch_frame.evaluate("([channel,origin]) => window.parent.frames[0].postMessage({type:'kopilka:vk-oauth',channel,token:'forged-by-mismatched-window'},origin)", [channel, urllib.parse.urlparse(BASE_URL).scheme + "://" + urllib.parse.urlparse(BASE_URL).netloc])
            vk_frame.wait_for_timeout(100)
            mismatch_token = vk_frame.evaluate("localStorage.getItem('kopilkaToken')")
            require(mismatch_token is None, f"handoff from a mismatched popup source was accepted: {mismatch_token}")
            host_page.evaluate("document.querySelector('#mismatch-frame')?.remove()")

            oauth_provider.authorize_gate.set()
            oauth_target = vk_frame
            if fallback_href:
                fallback_url = urllib.parse.urlparse(fallback_href)
                require(f"{fallback_url.scheme}://{fallback_url.netloc}" == BASE_URL and fallback_url.path == "/api/auth/vk-oauth/start", "popup-blocked cross-site fallback must stay on the first-party app origin")
                host_page.goto(fallback_href, wait_until="domcontentloaded")
                oauth_target = host_page
            oauth_target.locator("#appShell").wait_for(state="visible", timeout=20_000)
            oauth_target.wait_for_function("localStorage.getItem('kopilkaToken')")
            fallback_internal_id = oauth_target.evaluate("fetch('/api/me',{headers:{authorization:['Bearer',localStorage.getItem('kopilkaToken')].join(' ')}}).then(r=>r.json()).then(x=>x.user.id)")
            require(str(database_identity(fallback_internal_id, "vk_id")) == str(OAUTH_VK_USER_ID), "OAuth fallback handoff authenticated the wrong VK identity")
            seed_oauth_merge_data(fallback_internal_id)
            if not fallback_href:
                require(not host_page.evaluate("window.oauthMessages.some(item => item.type === 'kopilka:vk-oauth' && item.hasToken)"), "foreign top-level host received the OAuth token handoff")
            require(sum(1 for kind, _fields in oauth_provider.requests if kind == "authorize") == 1 and sum(1 for kind, _fields in oauth_provider.requests if kind == "token") == 1, "OAuth stand-in did not observe exactly one authorize/code exchange")
            if oauth_popup is not None:
                require(oauth_popup.is_closed() or oauth_popup.url.startswith(BASE_URL), "OAuth popup neither acknowledged/closed nor returned safely to the app origin")
            host_page.close()
            host_page = None
            blocked_page = context.new_page()
            blocked_page.add_init_script("window.open=()=>null; localStorage.removeItem('kopilkaToken');")
            blocked_page.goto(BASE_URL, wait_until="domcontentloaded")
            blocked_page.locator("#loginScreen").wait_for(state="visible", timeout=20_000)
            blocked_page.locator("#vkLoginButton").click()
            fallback_link = blocked_page.locator("#loginStatus a")
            fallback_link.wait_for(state="visible", timeout=20_000)
            fallback_url = urllib.parse.urlparse(fallback_link.get_attribute("href"))
            require(f"{fallback_url.scheme}://{fallback_url.netloc}" == BASE_URL and fallback_url.path == "/api/auth/vk-oauth/start", "popup-blocked fallback must be an accessible first-party OAuth link")
            fallback_copy = blocked_page.locator("#loginStatus").inner_text()
            require("Если" in fallback_copy or "If" in fallback_copy, "popup-blocked fallback must explain the first-party link")
            blocked_page.close()

            oauth_provider.user_id = 770_000_000 + os.getpid()
            attack_target_tg_id = 910_000_000 + os.getpid()
            attack_target_data = telegram_init_data(attack_target_tg_id)
            attack_a_page = context.new_page()
            attack_a_page.route("https://telegram.org/js/telegram-web-app.js", lambda route: route.fulfill(status=200, content_type="application/javascript", body="/* isolated local Telegram fixture */"))
            attack_a_page.add_init_script(f"localStorage.removeItem('kopilkaToken'); window.Telegram={{WebApp:{{initData:{json.dumps(attack_target_data)},initDataUnsafe:{{}},ready(){{}},expand(){{}}}}}};")
            attack_a_page.goto(BASE_URL, wait_until="domcontentloaded")
            wait_ready(attack_a_page)
            attack_target_id = attack_a_page.evaluate("state.user.id")
            require(database_identity(attack_target_id, "vk_id") is None, "transferable-link fixture target unexpectedly starts with VK")
            attack_intent = attack_a_page.evaluate("""async () => fetch('/api/auth/vk-oauth/intent', {method:'POST',headers:{'content-type':'application/json',authorization:['Bearer',localStorage.getItem('kopilkaToken')].join(' ')},body:JSON.stringify({action:'link',timezone:'UTC',locale:'ru'})}).then(r=>r.json())""")
            require(attack_intent.get("launchUrl"), "authenticated target could not create link intent")
            victim_context = browser.new_context()
            try:
                victim_page = victim_context.new_page()
                victim_page.route("https://telegram.org/js/telegram-web-app.js", lambda route: route.fulfill(status=200, content_type="application/javascript", body="/* isolated website fixture */"))
                victim_page.goto(attack_intent["launchUrl"], wait_until="domcontentloaded")
                victim_page.wait_for_timeout(3500)
                require(database_identity(attack_target_id, "vk_id") is None, "independent recipient linked a victim-approved VK identity to target A by opening a transferable URL")
                require(victim_page.evaluate("localStorage.getItem('kopilkaVkMergeToken')") is None, "independent recipient received a usable merge token before target-session finalize")
                require(victim_page.evaluate("localStorage.getItem('kopilkaToken')") is None, "independent recipient received target A app session from link callback")
            finally:
                victim_context.close()

            foreign_intent = attack_a_page.evaluate("""async () => fetch('/api/auth/vk-oauth/intent', {method:'POST',headers:{'content-type':'application/json',authorization:['Bearer',localStorage.getItem('kopilkaToken')].join(' ')},body:JSON.stringify({action:'link',timezone:'UTC',locale:'ru'})}).then(r=>r.json())""")
            foreign_session = context.request.post(f"{BASE_URL}/api/auth/dev", data={"firstName": "Foreign finalize session"}).json()
            foreign_context = browser.new_context()
            try:
                foreign_page = foreign_context.new_page()
                foreign_page.route("https://telegram.org/js/telegram-web-app.js", lambda route: route.fulfill(status=200, content_type="application/javascript", body="/* isolated website fixture */"))
                foreign_page.add_init_script(f"localStorage.setItem('kopilkaToken',{json.dumps(foreign_session['token'])});")
                foreign_page.goto(foreign_intent["launchUrl"], wait_until="domcontentloaded")
                wait_ready(foreign_page)
                require(database_identity(attack_target_id, "vk_id") is None, "foreign target session finalized a transferred OAuth link proof")
                require(database_identity(foreign_session["user"]["id"], "vk_id") is None, "foreign finalize rebound the verified VK identity to the recipient account")
                require(foreign_page.evaluate("localStorage.getItem('kopilkaVkMergeToken')") is None, "foreign target session received a usable merge token")
            finally:
                foreign_context.close()

            expired_intent = attack_a_page.evaluate("""async () => fetch('/api/auth/vk-oauth/intent', {method:'POST',headers:{'content-type':'application/json',authorization:['Bearer',localStorage.getItem('kopilkaToken')].join(' ')},body:JSON.stringify({action:'link',timezone:'UTC',locale:'ru'})}).then(r=>r.json())""")
            attack_a_page.evaluate("token => { state.token=token; localStorage.setItem('kopilkaToken',token); }", expired_session_token(attack_target_id))
            attack_a_page.goto(expired_intent["launchUrl"], wait_until="domcontentloaded")
            wait_ready(attack_a_page)
            require(database_identity(attack_target_id, "vk_id") is None, "expired target session finalized OAuth linking before platform renewal")
            require(latest_link_proof_consumed(attack_target_id) is None, "expired target session consumed the verified link proof")
            attack_a_page.close()
            evidence.append(["non-transferable-vk-link", "missing/foreign/expired target sessions rejected", "no binding or merge token", "passed"])

            oauth_provider.user_id = 771_000_000 + os.getpid()
            legitimate_tg_id = 920_000_000 + os.getpid()
            legitimate_page = context.new_page()
            legitimate_page.route("https://telegram.org/js/telegram-web-app.js", lambda route: route.fulfill(status=200, content_type="application/javascript", body="/* isolated local Telegram fixture */"))
            legitimate_page.add_init_script(f"localStorage.removeItem('kopilkaToken'); window.Telegram={{WebApp:{{initData:{json.dumps(telegram_init_data(legitimate_tg_id))},initDataUnsafe:{{}},ready(){{}},expand(){{}}}}}};")
            finalized_proofs = []
            legitimate_page.on("request", lambda request: finalized_proofs.append(request.post_data_json.get("proof")) if urllib.parse.urlparse(request.url).path == "/api/auth/vk-oauth/finalize-link" and request.post_data_json else None)
            legitimate_page.goto(BASE_URL, wait_until="domcontentloaded")
            wait_ready(legitimate_page)
            legitimate_internal_id = legitimate_page.evaluate("state.user.id")
            legitimate_page.locator("#tab-button-settings").click()
            legitimate_page.locator("#linkVkAccount").click()
            for _ in range(100):
                if str(database_identity(legitimate_internal_id, "vk_id")) == str(oauth_provider.user_id):
                    break
                legitimate_page.wait_for_timeout(100)
            require(str(database_identity(legitimate_internal_id, "vk_id")) == str(oauth_provider.user_id), "legitimate original target session did not finalize VK linking")
            require(finalized_proofs and finalized_proofs[-1], "legitimate popup flow did not use authenticated finalize proof")
            replay_status = legitimate_page.evaluate("proof => fetch('/api/auth/vk-oauth/finalize-link',{method:'POST',headers:{'content-type':'application/json',authorization:['Bearer',localStorage.getItem('kopilkaToken')].join(' ')},body:JSON.stringify({proof})}).then(r=>r.status)", finalized_proofs[-1])
            require(replay_status == 400, f"consumed link proof replay was not rejected: {replay_status}")
            legitimate_token = legitimate_page.evaluate("localStorage.getItem('kopilkaToken')")
            legitimate_page.close()

            merged_page = context.new_page()
            merged_private = []
            merged_page.on("request", lambda request: merged_private.append(request.headers.get("authorization")) if urllib.parse.urlparse(request.url).path.startswith("/api/") and not urllib.parse.urlparse(request.url).path.startswith("/api/auth/") and request.headers.get("authorization") else None)
            merged_page.add_init_script(f"localStorage.setItem('kopilkaToken',{json.dumps(legitimate_token)});")
            merged_page.goto(f"{BASE_URL}/?{vk_launch_params(oauth_provider.user_id)}", wait_until="domcontentloaded")
            wait_ready(merged_page)
            merged_token = merged_page.evaluate("localStorage.getItem('kopilkaToken')")
            require(merged_page.evaluate("state.user.id") == legitimate_internal_id, "merged Telegram/VK launch did not preserve the shared internal account")
            require(merged_private and all(token == f"Bearer {merged_token}" for token in merged_private), f"merged same-user VK launch used stale private-data credentials: {merged_private}")
            merged_page.close()
            evidence.append(["legitimate-vk-link-finalize", "original bearer", "one-time proof", "replay rejected", "merged identity preserved", "passed"])

            oauth_provider.user_id = OAUTH_VK_USER_ID
            link_user_id = 900_000_000 + os.getpid()
            link_init_data = telegram_init_data(link_user_id)
            link_page = context.new_page()
            link_page.route("https://telegram.org/js/telegram-web-app.js", lambda route: route.fulfill(status=200, content_type="application/javascript", body="/* isolated local Telegram fixture */"))
            link_page.add_init_script(f"localStorage.removeItem('kopilkaToken'); window.Telegram={{WebApp:{{initData:{json.dumps(link_init_data)},initDataUnsafe:{{}},ready(){{}},expand(){{}}}}}};")
            link_page.goto(BASE_URL, wait_until="domcontentloaded")
            wait_ready(link_page)
            link_internal_id = link_page.evaluate("fetch('/api/me',{headers:{authorization:['Bearer',localStorage.getItem('kopilkaToken')].join(' ')}}).then(r=>r.json()).then(x=>x.user.id)")
            link_page.locator("#tab-button-settings").click()
            link_page.locator("#linkVkAccount").click()
            for _ in range(100):
                if link_page.locator("#accountMergePrompt").is_visible() or link_page.locator("#vkLinkStatus a").count():
                    break
                link_page.wait_for_timeout(100)
            if not link_page.locator("#accountMergePrompt").is_visible():
                link_fallback = link_page.locator("#vkLinkStatus a").get_attribute("href")
                require(link_fallback and link_fallback.startswith(f"{BASE_URL}/api/auth/vk-oauth/start?"), "popup-blocked link flow did not expose a first-party fallback URL")
                assert link_fallback is not None
                link_page.goto(link_fallback, wait_until="domcontentloaded")
            link_page.locator("#accountMergePrompt").wait_for(state="visible", timeout=20_000)
            require(link_page.evaluate("state.pendingMerge && Boolean(state.pendingMerge.mergeToken)"), "VK OAuth link did not preserve the server-authorized merge context")
            require(str(database_identity(link_internal_id, "telegram_id")) == str(link_user_id), "VK OAuth link flow changed the initiating Telegram identity before confirmation")
            link_page.close()
            link_page = None
            evidence.append(["cross-site-vk-oauth", "signed fresh+expired immediate auth", "third-party cookies blocked", f"OAuth completion: {'popup handoff' if popup_opened else 'first-party top-level fallback'}", "local provider stand-in", "foreign-origin+mismatched-source rejected", "popup-blocked link", "link/merge context", "passed"])

            init_data = telegram_init_data(990001)
            renewal_auth_response = context.request.post(f"{BASE_URL}/api/auth/telegram", data={"initData": init_data, "timezone": "UTC"})
            require(renewal_auth_response.ok, "initial signed Telegram fixture auth failed")
            renewal_user_id = renewal_auth_response.json()["user"]["id"]
            renewal_page = context.new_page()
            renewal_errors = []
            renewal_page.on("pageerror", lambda error: renewal_errors.append(str(error)))
            renewal_page.route("https://telegram.org/js/telegram-web-app.js", lambda route: route.fulfill(status=200, content_type="application/javascript", body="/* isolated local Telegram fixture */"))
            renewal_page.add_init_script(f"window.Telegram={{WebApp:{{initData:{json.dumps(init_data)},initDataUnsafe:{{}},ready(){{}},expand(){{}}}}}};")
            renewal_page.goto(BASE_URL, wait_until="domcontentloaded")
            renewal_page.evaluate("token => localStorage.setItem('kopilkaToken', token)", expired_session_token(renewal_user_id))
            renewal_page.reload(wait_until="domcontentloaded")
            wait_ready(renewal_page)
            renewed_token = renewal_page.evaluate("localStorage.getItem('kopilkaToken')")
            require(renewed_token and renewed_token != expired_session_token(renewal_user_id), "expired session fixture was not renewed through signed Telegram initData")
            renewed_me = context.request.get(f"{BASE_URL}/api/me", headers={"Authorization": f"Bearer {renewed_token}"})
            require(renewed_me.ok and renewed_me.json()["user"]["id"] == renewal_user_id, "session renewal must preserve the same Telegram account")
            require(not renewal_errors, f"isolated renewal fixture had page errors: {renewal_errors}")
            evidence.append(["mocked-telegram-session-renewal", "local signed fixture only", "passed"])

            require(not errors, f"browser console/page errors: {errors}")
            print(json.dumps(evidence, ensure_ascii=False))
            print("browser audit qa passed")
        finally:
            if stale_page is not None:
                stale_page.close()
            if renewal_page is not None:
                renewal_page.close()
            if telegram_page is not None:
                telegram_page.close()
            if vk_page is not None:
                vk_page.close()
            if mismatch_page is not None:
                mismatch_page.close()
            if link_page is not None:
                link_page.close()
            if host_page is not None:
                host_page.close()
            page.close()
            context.close()


if __name__ == "__main__":
    run()
