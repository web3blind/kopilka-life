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
        env = dict(os.environ, NODE_ENV='test', PORT='3119',
                   DB_PATH=str(Path(tmp, 'qa.sqlite')), SCHEDULER_ENABLED='false',
                   DEV_AUTH_ENABLED='true', BOT_TOKEN='test-bot-token',
                   BOT_USERNAME='HarborLifeBot', SESSION_SECRET='browser-qa-session-secret',
                   TELEGRAM_WEBHOOK_SECRET='browser_qa_webhook_secret_123456',
                   VK_GROUP_TOKEN='', VK_GROUP_ID='240966481', VK_APP_ID='54723764',
                   VK_SECURE_KEY='browser-qa-vk-secure-key', VK_OAUTH_CLIENT_ID='54723764',
                   VK_OAUTH_CLIENT_SECRET='browser-qa-oauth-secret',
                   VK_OAUTH_AUTHORIZE_URL='http://localhost:4138/authorize',
                   VK_OAUTH_TOKEN_URL='http://localhost:4138/token',
                   APP_BASE_URL='http://127.0.0.1:3119', WEBAPP_URL='http://127.0.0.1:3119',
                   KOPILKA_QA_BASE_URL='http://127.0.0.1:3119',
                   KOPILKA_QA_OAUTH_PROVIDER_URL='http://localhost:4138',
                   DOTENV_CONFIG_PATH='/dev/null')
        with Path(tmp, 'server.log').open('w+') as log:
            proc = subprocess.Popen(['node', str(ROOT / 'src/server.js')], cwd=tmp, env=env, stdout=log, stderr=log)
            try:
                deadline = time.monotonic() + 15
                while True:
                    try:
                        urllib.request.urlopen(env['APP_BASE_URL'] + '/health', timeout=1).close()
                        break
                    except Exception:
                        if proc.poll() is not None or time.monotonic() > deadline:
                            log.seek(0)
                            raise RuntimeError(log.read())
                        time.sleep(.1)
                suites = sys.argv[1:] or ['browser-audit-qa.py', 'moderation-browser-qa.py', 'document-navigation-qa.py', 'support-share-browser-qa.py', 'quality-browser-qa.py']
                for suite in suites:
                    print('RUN', suite, flush=True)
                    subprocess.run([sys.executable, str(ROOT / 'tests' / suite)], env=env, cwd=tmp, check=True, timeout=300)
            finally:
                proc.terminate()
                try:
                    proc.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait()

if __name__ == '__main__':
    main()
