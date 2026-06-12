"""
AccountManager — Auto Gmail Creation for MMB AGENT 24/7
Adapted from MMB-Agent-v2/services/AccountManager.py

Features:
  1. 5sim OTP integration (FIVESIM_API_KEY from .env)
  2. Human-like form filling (name, DOB, password)
  3. Desktop signup only (Windows + Mac — NO Android)
  4. Browser warm-up before signup
  5. Per-profile deterministic fake identity (name/DOB/password)
  6. Created account saved to data/accounts/{profile_id}.json

5sim API endpoints:
  GET /v1/user/buy/activation/{country}/{operator}/{product}
  GET /v1/user/check/{order_id} — poll for OTP
  GET /v1/user/finish/{order_id} — mark complete
  GET /v1/user/cancel/{order_id} — cancel on failure

FIXED:
  ✅ Bug #1: aiohttp.ClientSession created fresh per-call → reuse pattern
             (was creating new TCP connection every API call — slow + wasteful)
  ✅ Bug #2: All tab.evaluate() calls wrapped with asyncio.wait_for timeout
             (no infinite hang on unresponsive tab)
  ✅ Bug #3: _verify_signup() uses proper JS eval with timeout
  ✅ Bug #4: send_keys_human() now passes typing_speed param (plan alignment)
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import random
import re
import string
import time
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any, Optional

import aiohttp

log = logging.getLogger("mmb.account_manager")

# ── Config ────────────────────────────────────────────────────────────────────
_FIVESIM_BASE      = "https://5sim.net/v1"
_FIVESIM_KEY       = os.getenv("FIVESIM_API_KEY", "")
_OTP_POLL_INTERVAL = 4.0    # seconds between OTP polls
_OTP_MAX_WAIT      = 120.0  # max seconds to wait for OTP
_ACCOUNT_DIR       = Path(__file__).resolve().parent.parent / "data" / "accounts"

# Google signup URL (desktop only)
_GOOGLE_SIGNUP_URL = (
    "https://accounts.google.com/signup/v2/webcreateaccount"
    "?flowName=GlifWebSignIn&flowEntry=SignUp"
)

# ── Name pools ────────────────────────────────────────────────────────────────
_FIRST_NAMES = [
    "James", "John", "Robert", "Michael", "William", "David", "Joseph", "Thomas",
    "Charles", "Christopher", "Daniel", "Matthew", "Anthony", "Mark", "Donald",
    "Emma", "Olivia", "Ava", "Isabella", "Sophia", "Mia", "Charlotte", "Amelia",
    "Harper", "Evelyn", "Abigail", "Emily", "Elizabeth", "Sofia", "Madison",
    "Alex", "Jordan", "Taylor", "Morgan", "Casey", "Riley", "Jamie", "Quinn",
]

_LAST_NAMES = [
    "Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller", "Davis",
    "Rodriguez", "Martinez", "Hernandez", "Lopez", "Gonzalez", "Wilson", "Anderson",
    "Thomas", "Taylor", "Moore", "Jackson", "Martin", "Lee", "Perez", "Thompson",
    "White", "Harris", "Sanchez", "Clark", "Ramirez", "Lewis", "Robinson",
]


# ── Data classes ──────────────────────────────────────────────────────────────

@dataclass
class FakeIdentity:
    """Deterministic fake identity for account creation."""
    profile_id: str
    first_name: str
    last_name:  str
    dob_day:    int
    dob_month:  int
    dob_year:   int
    gender:     str
    username:   str
    password:   str
    phone:      str = ""
    email:      str = ""
    order_id:   int = 0


@dataclass
class CreatedAccount:
    """A successfully created Gmail account."""
    profile_id: str
    email:      str
    password:   str
    first_name: str
    last_name:  str
    phone:      str
    created_at: float = field(default_factory=time.time)
    status:     str   = "active"

    def to_dict(self) -> dict:
        return asdict(self)


# ── 5sim Client ───────────────────────────────────────────────────────────────

class FiveSimClient:
    """
    Async 5sim.net API client.
    FIX #1: Uses a single shared aiohttp.ClientSession per instance
             instead of creating a new session for every API call.
    """

    def __init__(self) -> None:
        self._api_key = _FIVESIM_KEY
        self._headers = {
            "Authorization": f"Bearer {self._api_key}",
            "Accept": "application/json",
        }
        # FIX #1: Shared session — created lazily, reused across calls
        self._session: Optional[aiohttp.ClientSession] = None

    def _is_configured(self) -> bool:
        return bool(self._api_key and len(self._api_key) > 20)

    async def _get_session(self) -> aiohttp.ClientSession:
        """FIX #1: Lazy session creation — reuse across calls."""
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession(headers=self._headers)
        return self._session

    async def close(self) -> None:
        """Close the shared session when done."""
        if self._session and not self._session.closed:
            await self._session.close()
            self._session = None

    async def buy_number(
        self,
        country: str = "usa",
        operator: str = "any",
        product: str = "google",
    ) -> Optional[dict]:
        """
        Buy a phone number for activation.
        FIX #1: Uses shared session instead of new per-call.
        """
        if not self._is_configured():
            log.warning("[5sim] FIVESIM_API_KEY not configured")
            return None
        url = f"{_FIVESIM_BASE}/user/buy/activation/{country}/{operator}/{product}"
        try:
            session = await self._get_session()
            async with session.get(url, timeout=aiohttp.ClientTimeout(total=15)) as resp:
                if resp.status == 200:
                    data = await resp.json(content_type=None)
                    log.info("[5sim] Number bought: +%s order_id=%s",
                             data.get("phone"), data.get("id"))
                    return data
                text = await resp.text()
                log.warning("[5sim] buy_number HTTP %d: %s", resp.status, text[:200])
        except Exception as e:
            log.warning("[5sim] buy_number error: %s", e)
        return None

    async def get_sms(self, order_id: int) -> Optional[str]:
        """
        Poll for OTP SMS.
        FIX #1: Uses shared session.
        """
        if not self._is_configured():
            return None
        url      = f"{_FIVESIM_BASE}/user/check/{order_id}"
        deadline = time.monotonic() + _OTP_MAX_WAIT
        attempt  = 0

        while time.monotonic() < deadline:
            attempt += 1
            try:
                session = await self._get_session()
                async with session.get(url, timeout=aiohttp.ClientTimeout(total=10)) as resp:
                    if resp.status == 200:
                        data   = await resp.json(content_type=None)
                        status = data.get("status", "")

                        if status == "RECEIVED":
                            sms_list = data.get("sms", [])
                            if sms_list:
                                raw_text = sms_list[-1].get("text", "")
                                otp      = self._extract_otp(raw_text)
                                log.info("[5sim] OTP received (attempt %d): %r", attempt, otp)
                                return otp

                        if status in ("CANCELED", "TIMEOUT", "BANNED"):
                            log.warning("[5sim] Order %d status: %s", order_id, status)
                            return None

                        log.debug("[5sim] Waiting for SMS (attempt %d) status=%r", attempt, status)
            except Exception as e:
                log.debug("[5sim] get_sms poll error: %s", e)

            await asyncio.sleep(_OTP_POLL_INTERVAL)

        log.warning("[5sim] OTP timeout after %.0fs for order %d", _OTP_MAX_WAIT, order_id)
        return None

    async def finish_order(self, order_id: int) -> None:
        """Mark order as finished. FIX #1: shared session."""
        if not self._is_configured() or not order_id:
            return
        url = f"{_FIVESIM_BASE}/user/finish/{order_id}"
        try:
            session = await self._get_session()
            async with session.get(url, timeout=aiohttp.ClientTimeout(total=10)) as resp:
                log.info("[5sim] Order %d finished (HTTP %d)", order_id, resp.status)
        except Exception as e:
            log.debug("[5sim] finish_order error: %s", e)

    async def cancel_order(self, order_id: int) -> None:
        """Cancel order (refund). FIX #1: shared session."""
        if not self._is_configured() or not order_id:
            return
        url = f"{_FIVESIM_BASE}/user/cancel/{order_id}"
        try:
            session = await self._get_session()
            async with session.get(url, timeout=aiohttp.ClientTimeout(total=10)) as resp:
                log.info("[5sim] Order %d cancelled (HTTP %d)", order_id, resp.status)
        except Exception as e:
            log.debug("[5sim] cancel_order error: %s", e)

    def _extract_otp(self, sms_text: str) -> str:
        """Extract 6-digit OTP from SMS text."""
        match = re.search(r"\b([0-9]{6})\b", sms_text)
        if match:
            return match.group(1)
        match = re.search(r"\b([0-9]{4,8})\b", sms_text)
        return match.group(1) if match else sms_text.strip()

    async def get_balance(self) -> Optional[float]:
        """Check 5sim account balance. FIX #1: shared session."""
        if not self._is_configured():
            return None
        try:
            session = await self._get_session()
            async with session.get(
                f"{_FIVESIM_BASE}/user/profile",
                timeout=aiohttp.ClientTimeout(total=10),
            ) as resp:
                if resp.status == 200:
                    data    = await resp.json(content_type=None)
                    balance = float(data.get("balance", 0))
                    log.info("[5sim] Balance: $%.2f", balance)
                    return balance
        except Exception as e:
            log.debug("[5sim] balance error: %s", e)
        return None


# ── Identity generator ────────────────────────────────────────────────────────

def _generate_identity(profile_id: str) -> FakeIdentity:
    """Deterministic fake identity from profile_id SHA-256."""
    digest = hashlib.sha256(profile_id.encode()).hexdigest()
    rng    = random.Random(int(digest[:8], 16))

    first = rng.choice(_FIRST_NAMES)
    last  = rng.choice(_LAST_NAMES)

    dob_year  = rng.randint(1982, 2000)
    dob_month = rng.randint(1, 12)
    dob_day   = rng.randint(1, 28)
    gender    = rng.choice(["male", "female"])

    username = (
        first.lower()
        + last.lower()[:rng.randint(2, 5)]
        + str(rng.randint(10, 999))
    )

    pwd_chars = (
        string.ascii_uppercase + string.ascii_lowercase
        + string.digits + "!@#$%"
    )
    pwd_rng  = random.Random(int(digest[8:16], 16))
    password = (
        pwd_rng.choice(string.ascii_uppercase)
        + pwd_rng.choice(string.ascii_lowercase)
        + pwd_rng.choice(string.digits)
        + pwd_rng.choice("!@#$%")
        + "".join(pwd_rng.choice(pwd_chars) for _ in range(rng.randint(8, 12)))
    )

    return FakeIdentity(
        profile_id=profile_id,
        first_name=first, last_name=last,
        dob_day=dob_day, dob_month=dob_month, dob_year=dob_year,
        gender=gender, username=username, password=password,
    )


# ── Safe eval helper ──────────────────────────────────────────────────────────

async def _safe_eval(tab: Any, js: str, timeout: float = 8.0) -> Any:
    """FIX #2: All tab.evaluate calls go through here with timeout."""
    try:
        result = await asyncio.wait_for(
            tab.evaluate(js, return_by_value=True),
            timeout=timeout,
        )
        return getattr(result, "value", result)
    except asyncio.TimeoutError:
        log.debug("[AccountMgr] eval timeout after %.1fs", timeout)
        return None
    except Exception as e:
        log.debug("[AccountMgr] eval error: %s", e)
        return None


# ── AccountManager ────────────────────────────────────────────────────────────

class AccountManager:
    """
    Auto Gmail account creation — desktop browser only (Windows + Mac).
    Uses nodriver Tab + 5sim OTP.
    """

    def __init__(self) -> None:
        self._fivesim = FiveSimClient()
        self._rng     = random.Random()

    # ── Main entry point ──────────────────────────────────────────────────────

    async def create_gmail_account(
        self,
        tab: Any,
        profile_id: str,
        country: str = "usa",
    ) -> Optional[CreatedAccount]:
        """
        Full Gmail creation flow:
        1. Warm up browser
        2. Buy 5sim number
        3. Navigate to Google signup
        4. Fill name, username, password, DOB, gender
        5. Enter phone → wait OTP → enter OTP
        6. Complete signup
        7. Save account to disk
        Returns CreatedAccount or None on failure.
        """
        identity = _generate_identity(profile_id)
        log.info(
            "[AccountMgr] Creating Gmail for %s | name=%s %s username=%r",
            profile_id[:8], identity.first_name, identity.last_name, identity.username,
        )

        order_id = 0
        try:
            await self._warm_up_browser(tab)

            number_data = await self._fivesim.buy_number(country=country)
            if not number_data:
                log.warning("[AccountMgr] 5sim number unavailable — aborting")
                return None

            phone          = str(number_data.get("phone", ""))
            order_id       = int(number_data.get("id", 0))
            identity.phone = phone
            identity.order_id = order_id
            log.info("[AccountMgr] Phone: +%s | order=%d", phone, order_id)

            await self._navigate_to_signup(tab)

            if not await self._fill_name(tab, identity):
                raise RuntimeError("Name fields not found")
            await asyncio.sleep(self._rng.uniform(1.5, 3.0))

            if not await self._fill_username(tab, identity):
                raise RuntimeError("Username field not found")
            await asyncio.sleep(self._rng.uniform(1.0, 2.5))

            if not await self._fill_password(tab, identity):
                raise RuntimeError("Password fields not found")
            await asyncio.sleep(self._rng.uniform(1.5, 3.0))

            await self._fill_dob_gender(tab, identity)
            await asyncio.sleep(self._rng.uniform(1.5, 2.5))

            if not await self._enter_phone(tab, phone):
                raise RuntimeError("Phone field not found")
            await asyncio.sleep(self._rng.uniform(2.0, 4.0))

            otp = await self._fivesim.get_sms(order_id)
            if not otp:
                raise RuntimeError("OTP not received from 5sim")

            if not await self._enter_otp(tab, otp):
                raise RuntimeError("OTP field not found")
            await asyncio.sleep(self._rng.uniform(1.5, 3.0))

            await self._complete_signup(tab)
            await asyncio.sleep(self._rng.uniform(3.0, 5.0))

            success = await self._verify_signup(tab)
            if not success:
                raise RuntimeError("Signup verification failed")

            await self._fivesim.finish_order(order_id)

            email   = f"{identity.username}@gmail.com"
            account = CreatedAccount(
                profile_id=profile_id, email=email,
                password=identity.password,
                first_name=identity.first_name,
                last_name=identity.last_name,
                phone=phone, status="active",
            )
            self._save_account(account)
            log.info("[AccountMgr] ✓ Gmail created: %s | profile=%s", email, profile_id[:8])
            return account

        except Exception as e:
            log.warning("[AccountMgr] Creation failed for %s: %s", profile_id[:8], e)
            if order_id:
                await self._fivesim.cancel_order(order_id)
            return None

    # ── Step helpers ──────────────────────────────────────────────────────────

    async def _warm_up_browser(self, tab: Any) -> None:
        """Visit innocuous site before Google signup. FIX #2: timeout."""
        site = self._rng.choice(["https://www.google.com", "https://www.youtube.com"])
        try:
            log.info("[AccountMgr] Warm-up: %s", site)
            await asyncio.wait_for(tab.get(site), timeout=15.0)
            await asyncio.sleep(self._rng.uniform(2.0, 4.0))
            await _safe_eval(
                tab,
                f"window.scrollBy({{top: {self._rng.randint(200, 600)}, behavior: 'smooth'}})",
                timeout=5.0,
            )
            await asyncio.sleep(self._rng.uniform(1.5, 3.0))
        except Exception as e:
            log.debug("[AccountMgr] Warm-up error (non-fatal): %s", e)

    async def _navigate_to_signup(self, tab: Any) -> None:
        """Navigate to Google account creation page. FIX #2: timeout."""
        log.info("[AccountMgr] Navigating to Google signup")
        await asyncio.wait_for(tab.get(_GOOGLE_SIGNUP_URL), timeout=20.0)
        await asyncio.sleep(self._rng.uniform(2.0, 4.0))

    async def _fill_name(self, tab: Any, identity: FakeIdentity) -> bool:
        """Fill first + last name. FIX #2/#4: timeout + typing_speed."""
        from server_python.human_engine import send_keys_human
        try:
            raw = await _safe_eval(tab, """
            (function() {
                var first = document.querySelector(
                    'input[name="firstName"], input[autocomplete="given-name"], #firstName'
                );
                var last = document.querySelector(
                    'input[name="lastName"], input[autocomplete="family-name"], #lastName'
                );
                return {first: !!first, last: !!last};
            })()
            """)
            if not (isinstance(raw, dict) and raw.get("first")):
                return False

            await _safe_eval(tab,
                'document.querySelector(\'input[name="firstName"],#firstName\').click()',
                timeout=5.0)
            await asyncio.sleep(self._rng.uniform(0.3, 0.7))
            # FIX #4: typing_speed passed
            await send_keys_human(tab, identity.first_name, self._rng, typing_speed="medium")
            await asyncio.sleep(self._rng.uniform(0.5, 1.2))

            await _safe_eval(tab,
                'document.querySelector(\'input[name="lastName"],#lastName\').click()',
                timeout=5.0)
            await asyncio.sleep(self._rng.uniform(0.3, 0.7))
            await send_keys_human(tab, identity.last_name, self._rng, typing_speed="medium")

            await self._click_next(tab)
            return True
        except Exception as e:
            log.warning("[AccountMgr] _fill_name error: %s", e)
            return False

    async def _fill_username(self, tab: Any, identity: FakeIdentity) -> bool:
        """Fill Gmail username. FIX #2/#4: timeout + typing_speed."""
        from server_python.human_engine import send_keys_human
        try:
            await asyncio.sleep(self._rng.uniform(1.0, 2.5))
            for _ in range(10):
                found = await _safe_eval(tab,
                    'document.querySelector(\'input[name="Username"],#username,'
                    'input[autocomplete="username"]\')',
                    timeout=3.0)
                if found:
                    break
                await asyncio.sleep(0.5)

            await _safe_eval(tab,
                'document.querySelector(\'input[name="Username"],#username\').click()',
                timeout=5.0)
            await asyncio.sleep(self._rng.uniform(0.3, 0.7))
            await send_keys_human(tab, identity.username, self._rng, typing_speed="medium")
            await asyncio.sleep(self._rng.uniform(0.5, 1.0))
            await self._click_next(tab)
            return True
        except Exception as e:
            log.warning("[AccountMgr] _fill_username error: %s", e)
            return False

    async def _fill_password(self, tab: Any, identity: FakeIdentity) -> bool:
        """Fill password + confirm. FIX #2/#4: timeout + typing_speed."""
        from server_python.human_engine import send_keys_human
        try:
            await asyncio.sleep(self._rng.uniform(1.5, 3.0))
            await _safe_eval(tab,
                'document.querySelector(\'input[name="Passwd"],input[type="password"],#password\').click()',
                timeout=5.0)
            await asyncio.sleep(self._rng.uniform(0.4, 0.8))
            # FIX #4: slow typing for password (human careful)
            await send_keys_human(tab, identity.password, self._rng, typing_speed="slow")
            await asyncio.sleep(self._rng.uniform(0.8, 1.5))

            await _safe_eval(tab, """
            (function() {
                var inputs = document.querySelectorAll('input[type="password"]');
                if (inputs.length >= 2) { inputs[1].click(); return true; }
                var confirm = document.querySelector(
                    'input[name="ConfirmPasswd"], #confirm-passwd, input[autocomplete="new-password"]'
                );
                if (confirm) { confirm.click(); return true; }
                return false;
            })()
            """, timeout=5.0)
            await asyncio.sleep(self._rng.uniform(0.3, 0.7))
            await send_keys_human(tab, identity.password, self._rng, typing_speed="slow")
            await asyncio.sleep(self._rng.uniform(0.5, 1.0))
            await self._click_next(tab)
            return True
        except Exception as e:
            log.warning("[AccountMgr] _fill_password error: %s", e)
            return False

    async def _fill_dob_gender(self, tab: Any, identity: FakeIdentity) -> None:
        """Fill DOB + gender. FIX #2: timeout."""
        from server_python.human_engine import send_keys_human
        try:
            await asyncio.sleep(self._rng.uniform(1.5, 3.0))

            await _safe_eval(tab, f"""
            (function() {{
                var sel = document.querySelector('select#month, select[name="month"]');
                if (sel) {{ sel.value = '{identity.dob_month}'; sel.dispatchEvent(new Event('change')); }}
            }})()
            """, timeout=5.0)
            await asyncio.sleep(self._rng.uniform(0.3, 0.8))

            await _safe_eval(tab,
                'document.querySelector(\'input#day, input[name="day"]\').click(); true',
                timeout=5.0)
            await asyncio.sleep(self._rng.uniform(0.2, 0.5))
            await send_keys_human(tab, str(identity.dob_day), self._rng, typing_speed="medium")
            await asyncio.sleep(self._rng.uniform(0.3, 0.7))

            await _safe_eval(tab,
                'document.querySelector(\'input#year, input[name="year"]\').click(); true',
                timeout=5.0)
            await asyncio.sleep(self._rng.uniform(0.2, 0.5))
            await send_keys_human(tab, str(identity.dob_year), self._rng, typing_speed="medium")
            await asyncio.sleep(self._rng.uniform(0.3, 0.7))

            gender_val = "1" if identity.gender == "male" else "2"
            await _safe_eval(tab, f"""
            (function() {{
                var sel = document.querySelector('select#gender, select[name="gender"]');
                if (sel) {{ sel.value = '{gender_val}'; sel.dispatchEvent(new Event('change')); }}
            }})()
            """, timeout=5.0)
            await asyncio.sleep(self._rng.uniform(0.5, 1.0))
            await self._click_next(tab)
        except Exception as e:
            log.debug("[AccountMgr] _fill_dob_gender error (non-fatal): %s", e)

    async def _enter_phone(self, tab: Any, phone: str) -> bool:
        """Enter phone number. FIX #2/#4: timeout + typing_speed."""
        from server_python.human_engine import send_keys_human
        try:
            await asyncio.sleep(self._rng.uniform(2.0, 4.0))
            for _ in range(15):
                found = await _safe_eval(tab, """
                (function() {
                    var el = document.querySelector(
                        'input[type="tel"], input[name="phoneNumberId"], '
                        + 'input[autocomplete="tel"], #phoneNumberId'
                    );
                    return !!el;
                })()
                """, timeout=3.0)
                if found:
                    break
                await asyncio.sleep(0.5)

            await _safe_eval(tab, """
            (function() {
                var el = document.querySelector(
                    'input[type="tel"],input[name="phoneNumberId"],#phoneNumberId'
                );
                if (el) el.click();
            })()
            """, timeout=5.0)
            await asyncio.sleep(self._rng.uniform(0.4, 0.8))
            phone_clean = phone.lstrip("+")
            await send_keys_human(tab, phone_clean, self._rng, typing_speed="medium")
            await asyncio.sleep(self._rng.uniform(0.5, 1.2))
            await self._click_next(tab)
            return True
        except Exception as e:
            log.warning("[AccountMgr] _enter_phone error: %s", e)
            return False

    async def _enter_otp(self, tab: Any, otp: str) -> bool:
        """Enter OTP code. FIX #2/#4: timeout + slow typing."""
        from server_python.human_engine import send_keys_human
        try:
            await asyncio.sleep(self._rng.uniform(1.5, 3.0))
            for _ in range(15):
                found = await _safe_eval(tab, """
                (function() {
                    var el = document.querySelector(
                        'input[name="code"], input[name="smsUserPin"], '
                        + '#smsVerificationCode, input[type="tel"]'
                    );
                    return !!el;
                })()
                """, timeout=3.0)
                if found:
                    break
                await asyncio.sleep(0.5)

            await _safe_eval(tab, """
            (function() {
                var el = document.querySelector(
                    'input[name="code"],input[name="smsUserPin"],#smsVerificationCode'
                );
                if (el) el.click();
            })()
            """, timeout=5.0)
            await asyncio.sleep(self._rng.uniform(0.4, 1.0))
            # FIX #4: slow careful typing for OTP
            await send_keys_human(tab, otp, self._rng, typing_speed="slow")
            await asyncio.sleep(self._rng.uniform(0.8, 1.5))
            await self._click_next(tab)
            return True
        except Exception as e:
            log.warning("[AccountMgr] _enter_otp error: %s", e)
            return False

    async def _complete_signup(self, tab: Any) -> None:
        """Accept terms. FIX #2: timeout."""
        try:
            await asyncio.sleep(self._rng.uniform(2.0, 4.0))
            await _safe_eval(tab, """
            (function() {
                var btns = document.querySelectorAll('button, [role="button"]');
                var accept_texts = ['i agree', 'accept', 'agree', 'confirm', 'next'];
                for (var i = 0; i < btns.length; i++) {
                    var t = (btns[i].innerText || '').toLowerCase().trim();
                    if (accept_texts.some(function(x) { return t === x || t.indexOf(x) !== -1; })) {
                        btns[i].click();
                        return t;
                    }
                }
                return null;
            })()
            """, timeout=8.0)
            await asyncio.sleep(self._rng.uniform(2.0, 4.0))
        except Exception as e:
            log.debug("[AccountMgr] _complete_signup error (non-fatal): %s", e)

    async def _verify_signup(self, tab: Any) -> bool:
        """
        Check if signup succeeded.
        FIX #3: Uses _safe_eval with timeout instead of raw evaluate.
        """
        for _ in range(20):
            url_str = await _safe_eval(
                tab, "(() => window.location.href)()", timeout=3.0
            )
            if url_str and any(x in str(url_str) for x in [
                "myaccount.google.com", "accounts.google.com/b/",
                "mail.google.com", "welcome", "congratulations",
            ]):
                return True
            await asyncio.sleep(0.5)
        return False

    async def _click_next(self, tab: Any) -> None:
        """Click Next/Continue button. FIX #2: timeout."""
        try:
            await _safe_eval(tab, """
            (function() {
                var candidates = document.querySelectorAll('button, [role="button"]');
                var next_texts = ['next', 'continue', 'confirm', 'done'];
                for (var i = 0; i < candidates.length; i++) {
                    var t = (candidates[i].innerText || '').toLowerCase().trim();
                    if (next_texts.some(function(x) { return t === x; })) {
                        candidates[i].click();
                        return true;
                    }
                }
                var submit = document.querySelector('input[type="submit"], button[type="submit"]');
                if (submit) { submit.click(); return true; }
                return false;
            })()
            """, timeout=5.0)
            await asyncio.sleep(self._rng.uniform(1.0, 2.0))
        except Exception as e:
            log.debug("[AccountMgr] _click_next error: %s", e)

    # ── Account persistence ───────────────────────────────────────────────────

    def _save_account(self, account: CreatedAccount) -> None:
        """Atomic save account to disk."""
        _ACCOUNT_DIR.mkdir(parents=True, exist_ok=True)
        safe_id = "".join(c for c in account.profile_id[:12] if c.isalnum() or c in "-_")
        p   = _ACCOUNT_DIR / f"{safe_id}.json"
        tmp = _ACCOUNT_DIR / f"{safe_id}.tmp"
        try:
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(account.to_dict(), f, indent=2)
            tmp.replace(p)
            log.info("[AccountMgr] Account saved: %s", p.name)
        except Exception as e:
            log.warning("[AccountMgr] Save error: %s", e)

    def load_account(self, profile_id: str) -> Optional[CreatedAccount]:
        """Load saved account for a profile."""
        safe_id = "".join(c for c in profile_id[:12] if c.isalnum() or c in "-_")
        p = _ACCOUNT_DIR / f"{safe_id}.json"
        try:
            if p.exists():
                with open(p, "r", encoding="utf-8") as f:
                    return CreatedAccount(**json.load(f))
        except Exception as e:
            log.debug("[AccountMgr] Load error: %s", e)
        return None

    def list_accounts(self) -> list[dict]:
        """List all created accounts."""
        accounts = []
        try:
            if _ACCOUNT_DIR.exists():
                for p in _ACCOUNT_DIR.glob("*.json"):
                    try:
                        with open(p, "r", encoding="utf-8") as f:
                            accounts.append(json.load(f))
                    except Exception:
                        pass
        except Exception:
            pass
        return accounts


# ── Singleton ─────────────────────────────────────────────────────────────────

_account_manager: Optional[AccountManager] = None


def get_account_manager() -> AccountManager:
    global _account_manager
    if _account_manager is None:
        _account_manager = AccountManager()
    return _account_manager
