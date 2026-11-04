#!/usr/bin/env python3
"""Reuse unchanged Nov1 contracts, opening native archive with trusted Enter.
The original mouse toggle intermittently remains closed on BOTH CSS preimage and
candidate (see layout/nov1-*.log); no app behavior or assertions are replaced.
"""
import runpy
from pathlib import Path
from playwright.sync_api import Locator

original_click = Locator.click


def click(self, *args, **kwargs):
    if self._impl_obj._selector == '#aiWeeklyArchive summary':
        self.focus()
        self.press('Enter')
        assert self.evaluate('(n)=>n.parentElement.open'), 'Native keyboard archive toggle failed'
        return None
    return original_click(self, *args, **kwargs)


Locator.click = click
try:
    runpy.run_path(str(Path(__file__).with_name('ai-result-actions-browser-qa.py')), run_name='__main__')
finally:
    Locator.click = original_click
