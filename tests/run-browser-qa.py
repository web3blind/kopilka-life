#!/usr/bin/env python3
"""Run connected browser checks on temporary data via the existing local CDP rail."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]

def main():
    with tempfile.TemporaryDirectory(prefix='kopilka-browser-suite-') as tmp:
        for name in ('public', 'migrations'):
            Path(tmp, name).symlink_to(ROOT / name, target_is_directory=True)
        port = os.environ.get('KOPILKA_QA_PORT', '3119')
        link_matrix = 'link-matrix-browser-qa.py' in sys.argv[1:]
        env = dict(os.environ, NODE_ENV='test', PORT=port,
                   GEO_COUNTRY_DB_PATH=str(Path(tmp, 'missing-country.mmdb')),
                   RESEND_API_KEY='',
                   DB_PATH=str(Path(tmp, 'qa.sqlite')), SCHEDULER_ENABLED='false',
                   DEV_AUTH_ENABLED='true', BOT_TOKEN='test-bot-token',
                   BOT_USERNAME='HarborLifeBot', SESSION_SECRET='browser-qa-session-secret',
                   TELEGRAM_WEBHOOK_SECRET='browser_qa_webhook_secret_123456',
                   VK_GROUP_TOKEN='', VK_GROUP_ID='240966481', VK_APP_ID='54723764',
                   # Do not inherit production PNG limits through dotenv; this
                   # isolated suite intentionally opens many editors per minute.
                   RATE_LIMIT_STORY_MAX=os.environ.get('RATE_LIMIT_STORY_MAX', '200'),
                   RATE_LIMIT_STORY_WINDOW_MS=os.environ.get('RATE_LIMIT_STORY_WINDOW_MS', '60000'),
                   VK_SECURE_KEY='browser-qa-vk-secure-key', VK_OAUTH_CLIENT_ID='54723764',
                   VK_OAUTH_CLIENT_SECRET='browser-qa-oauth-secret',
                   VK_OAUTH_AUTHORIZE_URL='http://localhost:4138/authorize',
                   VK_OAUTH_TOKEN_URL='http://localhost:4138/token',
                   APP_BASE_URL=f'http://127.0.0.1:{port}', WEBAPP_URL=f'http://127.0.0.1:{port}',
                   KOPILKA_QA_BASE_URL=f'http://127.0.0.1:{port}',
                   KOPILKA_QA_OAUTH_PROVIDER_URL='http://localhost:4138',
                   DOTENV_CONFIG_PATH='/dev/null')
        vk_recovery = 'vk-login-recovery-browser-qa.py' in sys.argv[1:]
        if vk_recovery:
            env.update(VK_OAUTH_AUTHORIZE_URL='http://127.0.0.1:32992/authorize',
                       VK_OAUTH_TOKEN_URL='https://qa-vk.invalid/token',
                       RATE_LIMIT_AUTH_MAX='500',
                       NODE_OPTIONS=f"--require={ROOT / 'tests/fixtures/vk-login-recovery-preload.cjs'}")
        if 'vk-quota-browser-qa.py' in sys.argv[1:]:
            # Exhaust only the fixture's tiny local limiter; never real VK quotas.
            env.update(RATE_LIMIT_AUTH_MAX='2', RATE_LIMIT_AUTH_WINDOW_MS='3000')
        if 'push-browser-qa.py' in sys.argv[1:]:
            import json
            keys = json.loads(subprocess.check_output(['node', '-e', "console.log(JSON.stringify(require('web-push').generateVAPIDKeys()))"], cwd=ROOT))
            env.update(VAPID_PUBLIC_KEY=keys['publicKey'], VAPID_PRIVATE_KEY=keys['privateKey'],
                       VAPID_SUBJECT='mailto:qa@example.invalid', GEO_COUNTRY_DB_PATH='',
                       APP_BASE_URL=f'http://127.0.0.1:{port}', WEBAPP_URL=f'http://127.0.0.1:{port}',
                       KOPILKA_QA_BASE_URL=f'http://127.0.0.1:{port}')
        if link_matrix:
            env.update(GEO_COUNTRY_DB_PATH='', RESEND_API_KEY='fixture-only', GOOGLE_CLIENT_ID='fixture-google-client',
                       GOOGLE_CLIENT_SECRET='fixture-google-secret',
                       KOPILKA_LINK_QA_CODES=str(Path(tmp, 'last-email-code.json')),
                       NODE_OPTIONS=f"--require={ROOT / 'tests/fixtures/link-provider-preload.cjs'}",
                       APP_BASE_URL=f'http://127.0.0.1:{port}',
                       WEBAPP_URL=f'http://127.0.0.1:{port}',
                       KOPILKA_QA_BASE_URL=f'http://127.0.0.1:{port}')
        if 'partner-browser-qa.py' in sys.argv[1:]:
            env.update(TURNSTILE_SITE_KEY='fixture-site-key', TURNSTILE_SECRET_KEY='fixture-secret',
                       PARTNER_OWNER_TELEGRAM_ID='123456', RESEND_API_KEY='fixture-only',
                       NODE_OPTIONS=f"--require={ROOT / 'tests/fixtures/partner-provider-preload.cjs'}")
        if 'ai-weekly-browser-qa.py' in sys.argv[1:]:
            env.update(AI_WEEKLY_ENABLED='true', AI_WEEKLY_OPENROUTER_API_KEY='fixture-only',
                       AI_WEEKLY_PAID_ENABLED=os.environ.get('KOPILKA_AI_QA_PAID', 'false'),
                       AI_WEEKLY_MODEL='mistralai/mistral-nemo' if os.environ.get('KOPILKA_AI_QA_PAID') == 'true' else 'xingchen-agi/xing4.0-29b-a4b:free', AI_WEEKLY_TIMEOUT_MS='3000',
                       KOPILKA_AI_QA_CALLS=str(Path(tmp, 'ai-calls.json')),
                       NODE_OPTIONS=f"--require={ROOT / 'tests/fixtures/ai-weekly-browser-preload.cjs'}")
        with Path(tmp, 'server.log').open('w+') as log:
            # sendFile rejects absolute paths with dot-directory components; this
            # scratch directory may live under .hermes. DB and logs stay isolated.
            proc = subprocess.Popen(['node', str(ROOT / 'src/server.js')], cwd=tmp if vk_recovery else ROOT, env=env, stdout=log, stderr=log)
            try:
                deadline = time.monotonic() + 45
                while True:
                    try:
                        urllib.request.urlopen(env['APP_BASE_URL'] + '/health', timeout=1).close()
                        break
                    except Exception:
                        if proc.poll() is not None or time.monotonic() > deadline:
                            log.seek(0)
                            raise RuntimeError(log.read())
                        time.sleep(.1)
                suites = sys.argv[1:] or ['browser-audit-qa.py', 'moderation-browser-qa.py', 'document-navigation-qa.py', 'support-share-browser-qa.py', 'quality-browser-qa.py', 'day-scene-browser-qa.py', 'install-startup-browser-qa.py', 'quick-icons-timezone-browser-qa.py']
                for suite in suites:
                    print('RUN', suite, flush=True)
                    subprocess.run([sys.executable, str(ROOT / 'tests' / suite)], env=env, cwd=tmp, check=True, timeout=600)
            finally:
                proc.terminate()
                try:
                    proc.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait()

if __name__ == '__main__':
    main()
