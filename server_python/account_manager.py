"""
AccountManager — Auto Gmail Creation for MMB AGENT 24/7
Adapted from MMB-Agent-v2/services/AccountManager.py

Features:
  1. 5sim OTP integration  (FIVESIM_API_KEY from .env)
  2. Human-like form filling (name, DOB, password)
  3. Desktop signup only   (Windows + Mac — NO Android)
  4. Browser warm-up before signup
  5. Per-profile deterministic fake identity (name/DOB/password)
  6. Created account saved to data/accounts/{profile_id}.json

5sim API endpoints:
  GET /v1/user/buy/activation/{country}/{operator}/{product}
  GET /v1/user/check/{order_id}     — poll for OTP
  GET /v1/user/finish/{order_id}    — mark complete
  GET /v1/user/cancel/{order_id}    — cancel on failure

NOTE: Android code is NOT included — Windows + Mac only as per project rules.
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
_FIVESIM_BASE = "https://5sim.net/v1"
_FIVESIM_KEY  = os.getenv("FIVESIM_API_KEY", "")
_OTP_POLL_INTERVAL = 4.0    # seconds between OTP polls
_OTP_MAX_WAIT      = 120.0  # max seconds to wait for OTP
_ACCOUNT_DIR = Path(__file__).resolve().parent.parent / "data" / "accounts"

# Google signup URL (desktop only)
_GOOGLE_SIGNUP_URL = (
    "https://accounts.google.com/signup/v2/webcreateaccount"
    "?flowName=GlifWebSignIn&flowEntry=SignUp"
)

# ── Name pools (realistic, common) ────────────────────────────────────────────
_FIRST_NAMES = [
    "James","John","Robert","Michael","William","David","Joseph","Thomas",
    "Charles","Christopher","Daniel","Matthew","Anthony","Mark","Donald",
    "Emma","Olivia","Ava","Isabella","Sophia","Mia","Charlotte","Amelia",
    "Harper","Evelyn","Abigail","Emily","Elizabeth","Sofia","Madison",
    "Alex","Jordan","Taylor","Morgan","Casey","Riley","Jamie","Quinn",
]

_LAST_NAMES = [
    "Smith","Johnson","Williams","Brown","Jones","Garcia","Miller","Davis",
    "Rodriguez","Martinez","Hernandez","Lopez","Gonzalez","Wilson","Anderson",
    "Thomas","Taylor","Moore","Jackson","Martin","Lee","Perez","Thompson",
    "White","Harris","Sanchez","Clark","Ramirez","Lewis","Robinson",
]

# ── Data classes ──────────────────────────────────────────────────────────────

@dataclass
class FakeIdentity:
    """Deterministic fake identity for account creation."""
    profile_id:  str
    first_name:  str
    last_name:   str
    dob_day:     int     # 1-28
    dob_month:   int     # 1-12
    dob_year:    int     # 1980-2000
    gender:      str     # "male" or "female"
    username:    str     # Gmail username (without @gmail.com)
    password:    str     # Strong password
    phone:       str = ""   # filled after 5sim buy
    email:       str = ""   # filled after creation
    order_id:    int = 0    # 5sim order ID


@dataclass
class CreatedAccount:
    """A successfully created Gmail account."""
    profile_id:  str
    email:       str
    password:    str
    first_name:  str
    last_name:   str
    phone:       str
    created_at:  float = field(default_factory=time.time)
    status:      str = "active"   # active / failed / unverified

    def to_dict(self) -> dict:
        return asdict(self)


# ── 5sim Client ───────────────────────────────────────────────────────────────

class FiveSimClient:
    """
    Async 5sim.net API client.
    FIVESIM_API_KEY from .env
    """

    def __init__(self) -> None:
        self._api_key = _FIVESIM_KEY
        self._headers = {
            "Authorization": f"Bearer {self._api_key}",
            "Accept": "application/json",
        }

    def _is_configured(self) -> bool:
        return bool(self._api_key and len(self._api_key) > 20)

    async def buy_number(
        self,
        country: str = "usa",
        operator: str = "any",
        product: str = "google",
    ) -> Optional[dict]:
        """
        Buy a phone number for activation.
        Returns: {id, phone, status, ...} or None on error.
        """
        if not self._is_configured():
            log.warning("[5sim] FIVESIM_API_KEY not configured")
            return None
        url = f"{_FIVESIM_BASE}/user/buy/activation/{country}/{operator}/{product}"
        try:
            async with aiohttp.ClientSession(headers=self._headers) as session:
                async with session.get(
                    url, timeout=aiohttp.ClientTimeout(total=15)
                ) as resp:
                    if resp.status == 200:
                        data = await resp.json(content_type=None)
                        log.info(
                            f"[5sim] Number bought: +{data.get('phone')} "
                            f"order_id={data.get('id')}"
                        )
                        return data
                    text = await resp.text()
                    log.warning(f"[5sim] buy_number HTTP {resp.status}: {text[:200]}")
        except Exception as e:
            log.warning(f"[5sim] buy_number error: {e}")
        return None

    async def get_sms(self, order_id: int) -> Optional[str]:
        """
        Poll for OTP SMS. Returns OTP string or None on timeout.
        Polls every _OTP_POLL_INTERVAL seconds, max _OTP_MAX_WAIT seconds.
        """
        if not self._is_configured():
            return None
        url = f"{_FIVESIM_BASE}/user/check/{order_id}"
        deadline = time.monotonic() + _OTP_MAX_WAIT
        attempt = 0

        while time.monotonic() < deadline:
            attempt += 1
            try:
                async with aiohttp.ClientSession(headers=self._headers) as session:
                    async with session.get(
                        url, timeout=aiohttp.ClientTimeout(total=10)
                    ) as resp:
                        if resp.status == 200:
                            data = await resp.json(content_type=None)
                            status = data.get("status", "")

                            if status == "RECEIVED":
                                sms_list = data.get("sms", [])
                                if sms_list:
                                    raw_text = sms_list[-1].get("text", "")
                                    otp = self._extract_otp(raw_text)
                                    log.info(
                                        f"[5sim] OTP received (attempt {attempt}): {otp!r}"
                                    )
                                    return otp

                            if status in ("CANCELED", "TIMEOUT", "BANNED"):
                                log.warning(f"[5sim] Order {order_id} status: {status}")
                                return None

                            log.debug(
                                f"[5sim] Waiting for SMS (attempt {attempt}) "
                                f"status={status!r}"
                            )
            except Exception as e:
                log.debug(f"[5sim] get_sms poll error: {e}")

            await asyncio.sleep(_OTP_POLL_INTERVAL)

        log.warning(f"[5sim] OTP timeout after {_OTP_MAX_WAIT}s for order {order_id}")
        return None

    async def finish_order(self, order_id: int) -> None:
        """Mark order as finished (phone number used successfully)."""
        if not self._is_configured() or not order_id:
            return
        url = f"{_FIVESIM_BASE}/user/finish/{order_id}"
        try:
            async with aiohttp.ClientSession(headers=self._headers) as session:
                async with session.get(url, timeout=aiohttp.ClientTimeout(total=10)) as resp:
                    log.info(f"[5sim] Order {order_id} finished (HTTP {resp.status})")
        except Exception as e:
            log.debug(f"[5sim] finish_order error: {e}")

    async def cancel_order(self, order_id: int) -> None:
        """Cancel order (phone number not used — refund)."""
        if not self._is_configured() or not order_id:
            return
        url = f"{_FIVESIM_BASE}/user/cancel/{order_id}"
        try:
            async with aiohttp.ClientSession(headers=self._headers) as session:
                async with session.get(url, timeout=aiohttp.ClientTimeout(total=10)) as resp:
                    log.info(f"[5sim] Order {order_id} cancelled (HTTP {resp.status})")
        except Exception as e:
            log.debug(f"[5sim] cancel_order error: {e}")

    def _extract_otp(self, sms_text: str) -> str:
        """Extract 6-digit OTP from SMS text."""
        # Google OTP: "G-123456 is your Google verification code."
        match = re.search(r'\b([0-9]{6})\b', sms_text)
        if match:
            return match.group(1)
        # Fallback: any 4-8 digit code
        match = re.search(r'\b([0-9]{4,8})\b', sms_text)
        return match.group(1) if match else sms_text.strip()

    async def get_balance(self) -> Optional[float]:
        """Check 5sim account balance."""
        if not self._is_configured():
            return None
        try:
            async with aiohttp.ClientSession(headers=self._headers) as session:
                async with session.get(
                    f"{_FIVESIM_BASE}/user/profile",
                    timeout=aiohttp.ClientTimeout(total=10)
                ) as resp:
                    if resp.status == 200:
                        data = await resp.json(content_type=None)
                        balance = float(data.get("balance", 0))
                        log.info(f"[5sim] Balance: ${balance:.2f}")
                        return balance
        except Exception as e:
            log.debug(f"[5sim] balance error: {e}")
        return None


# ── Identity generator ────────────────────────────────────────────────────────

def _generate_identity(profile_id: str) -> FakeIdentity:
    """
    Generate deterministic fake identity from profile_id SHA-256.
    Same profile always gets the same name/DOB/password.
    """
    digest = hashlib.sha256(profile_id.encode()).hexdigest()
    rng = random.Random(int(digest[:8], 16))

    first = rng.choice(_FIRST_NAMES)
    last  = rng.choice(_LAST_NAMES)

    dob_year  = rng.randint(1982, 2000)
    dob_month = rng.randint(1, 12)
    dob_day   = rng.randint(1, 28)  # safe for all months
    gender    = rng.choice(["male", "female"])

    # Username: firstname + last name chunk + digits
    username = (
        first.lower()
        + last.lower()[:rng.randint(2, 5)]
        + str(rng.randint(10, 999))
    )

    # Strong password: upper + lower + digits + special
    pwd_chars = (
        string.ascii_uppercase
        + string.ascii_lowercase
        + string.digits
        + "!@#$%"
    )
    pwd_rng = random.Random(int(digest[8:16], 16))
    password = (
        pwd_rng.choice(string.ascii_uppercase)
        + pwd_rng.choice(string.ascii_lowercase)
        + pwd_rng.choice(string.digits)
        + pwd_rng.choice("!@#$%")
        + "".join(pwd_rng.choice(pwd_chars) for _ in range(rng.randint(8, 12)))
    )

    return FakeIdentity(
        profile_id=profile_id,
        first_name=first,
        last_name=last,
        dob_day=dob_day,
        dob_month=dob_month,
        dob_year=dob_year,
        gender=gender,
        username=username,
        password=password,
    )


# ── AccountManager ────────────────────────────────────────────────────────────

class AccountManager:
    """
    Auto Gmail account creation — desktop browser only (Windows + Mac).
    Uses nodriver Tab + 5sim OTP.

    Usage:
        mgr = AccountManager()
        account = await mgr.create_gmail_account(tab, profile_id)
        # Returns CreatedAccount or None on failure
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
        1. Warm up browser (visit 2-3 sites)
        2. Buy 5sim number
        3. Navigate to Google signup
        4. Fill name, username, password, DOB
        5. Enter phone → wait OTP → enter OTP
        6. Complete signup
        7. Save account to disk
        Returns CreatedAccount or None on failure.
        """
        identity = _generate_identity(profile_id)
        log.info(
            f"[AccountMgr] Creating Gmail for {profile_id[:8]} | "
            f"name={identity.first_name} {identity.last_name} "
            f"username={identity.username!r}"
        )

        order_id = 0
        try:
            # Step 1: Warm up browser
            await self._warm_up_browser(tab)

            # Step 2: Buy phone number
            number_data = await self._fivesim.buy_number(country=country)
            if not number_data:
                log.warning("[AccountMgr] 5sim number unavailable — aborting")
                return None

            phone    = str(number_data.get("phone", ""))
            order_id = int(number_data.get("id", 0))
            identity.phone    = phone
            identity.order_id = order_id
            log.info(f"[AccountMgr] Phone: +{phone} | order={order_id}")

            # Step 3: Navigate to Google signup
            await self._navigate_to_signup(tab)

            # Step 4: Fill basic info (name)
            filled_name = await self._fill_name(tab, identity)
            if not filled_name:
                raise RuntimeError("Name fields not found")

            await asyncio.sleep(self._rng.uniform(1.5, 3.0))

            # Step 5: Fill username
            filled_user = await self._fill_username(tab, identity)
            if not filled_user:
                raise RuntimeError("Username field not found")

            await asyncio.sleep(self._rng.uniform(1.0, 2.5))

            # Step 6: Fill password
            filled_pwd = await self._fill_password(tab, identity)
            if not filled_pwd:
                raise RuntimeError("Password fields not found")

            await asyncio.sleep(self._rng.uniform(1.5, 3.0))

            # Step 7: Fill DOB + gender
            await self._fill_dob_gender(tab, identity)
            await asyncio.sleep(self._rng.uniform(1.5, 2.5))

            # Step 8: Phone verification
            phone_entered = await self._enter_phone(tab, phone)
            if not phone_entered:
                raise RuntimeError("Phone field not found")

            await asyncio.sleep(self._rng.uniform(2.0, 4.0))

            # Step 9: Wait for OTP + enter it
            otp = await self._fivesim.get_sms(order_id)
            if not otp:
                raise RuntimeError("OTP not received from 5sim")

            otp_entered = await self._enter_otp(tab, otp)
            if not otp_entered:
                raise RuntimeError("OTP field not found")

            await asyncio.sleep(self._rng.uniform(1.5, 3.0))

            # Step 10: Accept terms + complete
            await self._complete_signup(tab)
            await asyncio.sleep(self._rng.uniform(3.0, 5.0))

            # Verify success — check URL or page
            success = await self._verify_signup(tab)
            if not success:
                raise RuntimeError("Signup verification failed")

            # Mark 5sim order complete
            await self._fivesim.finish_order(order_id)

            # Save account
            email = f"{identity.username}@gmail.com"
            account = CreatedAccount(
                profile_id=profile_id,
                email=email,
                password=identity.password,
                first_name=identity.first_name,
                last_name=identity.last_name,
                phone=phone,
                status="active",
            )
            self._save_account(account)
            log.info(
                f"[AccountMgr] ✓ Gmail created: {email} | "
                f"profile={profile_id[:8]}"
            )
            return account

        except Exception as e:
            log.warning(f"[AccountMgr] Creation failed for {profile_id[:8]}: {e}")
            # Cancel 5sim order to get refund
            if order_id:
                await self._fivesim.cancel_order(order_id)
            return None

    # ── Step 1: Browser warm-up ───────────────────────────────────────────────

    async def _warm_up_browser(self, tab: Any) -> None:
        """Visit 2-3 innocuous sites before Google signup."""
        warmup_sites = [
            "https://www.google.com",
            "https://www.youtube.com",
        ]
        site = self._rng.choice(warmup_sites)
        try:
            log.info(f"[AccountMgr] Warm-up: {site}")
            await asyncio.wait_for(tab.get(site), timeout=15.0)
            await asyncio.sleep(self._rng.uniform(2.0, 4.0))
            # Random scroll
            await tab.evaluate(
                "window.scrollBy({top: %d, behavior: 'smooth'})" % self._rng.randint(200, 600),
                return_by_value=True,
            )
            await asyncio.sleep(self._rng.uniform(1.5, 3.0))
        except Exception as e:
            log.debug(f"[AccountMgr] Warm-up error (non-fatal): {e}")

    # ── Step 3: Navigate to signup ────────────────────────────────────────────

    async def _navigate_to_signup(self, tab: Any) -> None:
        """Navigate to Google account creation page."""
        log.info("[AccountMgr] Navigating to Google signup")
        await asyncio.wait_for(tab.get(_GOOGLE_SIGNUP_URL), timeout=20.0)
        await asyncio.sleep(self._rng.uniform(2.0, 4.0))

    # ── Step 4: Fill name ─────────────────────────────────────────────────────

    async def _fill_name(self, tab: Any, identity: FakeIdentity) -> bool:
        """Fill first name + last name fields."""
        from server_python.human_engine import send_keys_human
        try:
            result = await tab.evaluate(
                """
                (function() {
                    var first = document.querySelector(
                        'input[name="firstName"], input[autocomplete="given-name"], #firstName'
                    );
                    var last = document.querySelector(
                        'input[name="lastName"], input[autocomplete="family-name"], #lastName'
                    );
                    return {first: !!first, last: !!last};
                })()
                """,
                return_by_value=True,
            )
            raw = getattr(result, "value", result)
            if not (isinstance(raw, dict) and raw.get("first")):
                return False

            # Click + type first name
            await tab.evaluate(
                'document.querySelector(\'input[name="firstName"],#firstName\').click()',
                return_by_value=True
            )
            await asyncio.sleep(self._rng.uniform(0.3, 0.7))
            await send_keys_human(tab, identity.first_name, self._rng)
            await asyncio.sleep(self._rng.uniform(0.5, 1.2))

            # Click + type last name
            await tab.evaluate(
                'document.querySelector(\'input[name="lastName"],#lastName\').click()',
                return_by_value=True
            )
            await asyncio.sleep(self._rng.uniform(0.3, 0.7))
            await send_keys_human(tab, identity.last_name, self._rng)

            # Click Next
            await self._click_next(tab)
            return True
        except Exception as e:
            log.warning(f"[AccountMgr] _fill_name error: {e}")
            return False

    # ── Step 5: Fill username ─────────────────────────────────────────────────

    async def _fill_username(self, tab: Any, identity: FakeIdentity) -> bool:
        """Fill Gmail username field."""
        from server_python.human_engine import send_keys_human
        try:
            await asyncio.sleep(self._rng.uniform(1.0, 2.5))
            # Wait for username field
            for _ in range(10):
                found = await tab.evaluate(
                    'document.querySelector(\'input[name="Username"],#username,input[autocomplete="username"]\')',
                    return_by_value=True
                )
                if found and getattr(found, "value", found):
                    break
                await asyncio.sleep(0.5)

            await tab.evaluate(
                'document.querySelector(\'input[name="Username"],#username\').click()',
                return_by_value=True
            )
            await asyncio.sleep(self._rng.uniform(0.3, 0.7))
            await send_keys_human(tab, identity.username, self._rng)
            await asyncio.sleep(self._rng.uniform(0.5, 1.0))
            await self._click_next(tab)
            return True
        except Exception as e:
            log.warning(f"[AccountMgr] _fill_username error: {e}")
            return False

    # ── Step 6: Fill password ─────────────────────────────────────────────────

    async def _fill_password(self, tab: Any, identity: FakeIdentity) -> bool:
        """Fill password + confirm password fields."""
        from server_python.human_engine import send_keys_human
        try:
            await asyncio.sleep(self._rng.uniform(1.5, 3.0))

            # Password field
            await tab.evaluate(
                'document.querySelector(\'input[name="Passwd"],input[type="password"],#password\').click()',
                return_by_value=True
            )
            await asyncio.sleep(self._rng.uniform(0.4, 0.8))
            await send_keys_human(tab, identity.password, self._rng)
            await asyncio.sleep(self._rng.uniform(0.8, 1.5))

            # Confirm password field
            await tab.evaluate(
                """
                (function() {
                    var inputs = document.querySelectorAll('input[type="password"]');
                    if (inputs.length >= 2) { inputs[1].click(); return true; }
                    var confirm = document.querySelector(
                        'input[name="ConfirmPasswd"], #confirm-passwd, input[autocomplete="new-password"]'
                    );
                    if (confirm) { confirm.click(); return true; }
                    return false;
                })()
                """,
                return_by_value=True
            )
            await asyncio.sleep(self._rng.uniform(0.3, 0.7))
            await send_keys_human(tab, identity.password, self._rng)
            await asyncio.sleep(self._rng.uniform(0.5, 1.0))
            await self._click_next(tab)
            return True
        except Exception as e:
            log.warning(f"[AccountMgr] _fill_password error: {e}")
            return False

    # ── Step 7: Fill DOB + gender ─────────────────────────────────────────────

    async def _fill_dob_gender(self, tab: Any, identity: FakeIdentity) -> None:
        """Fill date of birth and gender dropdowns."""
        try:
            await asyncio.sleep(self._rng.uniform(1.5, 3.0))

            # Month dropdown
            await tab.evaluate(
                f"""
                (function() {{
                    var sel = document.querySelector('select#month, select[name="month"]');
                    if (sel) {{ sel.value = '{identity.dob_month}'; sel.dispatchEvent(new Event('change')); }}
                }})()
                """,
                return_by_value=True
            )
            await asyncio.sleep(self._rng.uniform(0.3, 0.8))

            # Day field
            from server_python.human_engine import send_keys_human
            day_el_clicked = await tab.evaluate(
                'document.querySelector(\'input#day, input[name="day"]\').click(); true',
                return_by_value=True
            )
            await asyncio.sleep(self._rng.uniform(0.2, 0.5))
            await send_keys_human(tab, str(identity.dob_day), self._rng)
            await asyncio.sleep(self._rng.uniform(0.3, 0.7))

            # Year field
            await tab.evaluate(
                'document.querySelector(\'input#year, input[name="year"]\').click(); true',
                return_by_value=True
            )
            await asyncio.sleep(self._rng.uniform(0.2, 0.5))
            await send_keys_human(tab, str(identity.dob_year), self._rng)
            await asyncio.sleep(self._rng.uniform(0.3, 0.7))

            # Gender dropdown
            gender_val = "1" if identity.gender == "male" else "2"
            await tab.evaluate(
                f"""
                (function() {{
                    var sel = document.querySelector('select#gender, select[name="gender"]');
                    if (sel) {{ sel.value = '{gender_val}'; sel.dispatchEvent(new Event('change')); }}
                }})()
                """,
                return_by_value=True
            )
            await asyncio.sleep(self._rng.uniform(0.5, 1.0))
            await self._click_next(tab)

        except Exception as e:
            log.debug(f"[AccountMgr] _fill_dob_gender error (non-fatal): {e}")

    # ── Step 8: Enter phone ───────────────────────────────────────────────────

    async def _enter_phone(self, tab: Any, phone: str) -> bool:
        """Enter phone number in verification field."""
        from server_python.human_engine import send_keys_human
        try:
            await asyncio.sleep(self._rng.uniform(2.0, 4.0))

            # Find phone input
            for _ in range(15):
                found = await tab.evaluate(
                    """
                    (function() {
                        var el = document.querySelector(
                            'input[type="tel"], input[name="phoneNumberId"], '
                            + 'input[autocomplete="tel"], #phoneNumberId'
                        );
                        return !!el;
                    })()
                    """,
                    return_by_value=True
                )
                raw = getattr(found, "value", found)
                if raw:
                    break
                await asyncio.sleep(0.5)

            await tab.evaluate(
                """
                (function() {
                    var el = document.querySelector(
                        'input[type="tel"],input[name="phoneNumberId"],#phoneNumberId'
                    );
                    if (el) el.click();
                })()
                """,
                return_by_value=True
            )
            await asyncio.sleep(self._rng.uniform(0.4, 0.8))

            # Type phone (may already have country code)
            phone_clean = phone.lstrip("+")
            await send_keys_human(tab, phone_clean, self._rng)
            await asyncio.sleep(self._rng.uniform(0.5, 1.2))
            await self._click_next(tab)
            return True

        except Exception as e:
            log.warning(f"[AccountMgr] _enter_phone error: {e}")
            return False

    # ── Step 9: Enter OTP ─────────────────────────────────────────────────────

    async def _enter_otp(self, tab: Any, otp: str) -> bool:
        """Enter OTP code received from 5sim."""
        from server_python.human_engine import send_keys_human
        try:
            await asyncio.sleep(self._rng.uniform(1.5, 3.0))

            # Find OTP/verification input
            for _ in range(15):
                found = await tab.evaluate(
                    """
                    (function() {
                        var el = document.querySelector(
                            'input[name="code"], input[name="smsUserPin"], '
                            + '#smsVerificationCode, input[type="tel"]'
                        );
                        return !!el;
                    })()
                    """,
                    return_by_value=True
                )
                raw = getattr(found, "value", found)
                if raw:
                    break
                await asyncio.sleep(0.5)

            await tab.evaluate(
                """
                (function() {
                    var el = document.querySelector(
                        'input[name="code"],input[name="smsUserPin"],#smsVerificationCode'
                    );
                    if (el) el.click();
                })()
                """,
                return_by_value=True
            )
            await asyncio.sleep(self._rng.uniform(0.4, 1.0))

            # Human-like OTP typing (slower, careful)
            await send_keys_human(tab, otp, self._rng)
            await asyncio.sleep(self._rng.uniform(0.8, 1.5))
            await self._click_next(tab)
            return True

        except Exception as e:
            log.warning(f"[AccountMgr] _enter_otp error: {e}")
            return False

    # ── Step 10: Complete signup ──────────────────────────────────────────────

    async def _complete_signup(self, tab: Any) -> None:
        """Accept terms and complete account creation."""
        try:
            await asyncio.sleep(self._rng.uniform(2.0, 4.0))

            # Accept terms (multiple possible selectors)
            await tab.evaluate(
                """
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
                """,
                return_by_value=True
            )
            await asyncio.sleep(self._rng.uniform(2.0, 4.0))
        except Exception as e:
            log.debug(f"[AccountMgr] _complete_signup error (non-fatal): {e}")

    async def _verify_signup(self, tab: Any) -> bool:
        """Check if we landed on a Google account page (signup success)."""
        try:
            for _ in range(20):
                url = await tab.evaluate("window.location.href", return_by_value=True)
                url_str = str(getattr(url, "value", url) or "")
                # Success indicators
                if any(x in url_str for x in [
                    "myaccount.google.com",
                    "accounts.google.com/b/",
                    "mail.google.com",
                    "welcome",
                    "congratulations",
                ]):
                    return True
                await asyncio.sleep(0.5)
        except Exception:
            pass
        return False

    # ── Next button helper ────────────────────────────────────────────────────

    async def _click_next(self, tab: Any) -> None:
        """Click the Next/Continue button on the current signup step."""
        try:
            await tab.evaluate(
                """
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
                    // Fallback: form submit button
                    var submit = document.querySelector('input[type="submit"], button[type="submit"]');
                    if (submit) { submit.click(); return true; }
                    return false;
                })()
                """,
                return_by_value=True
            )
            await asyncio.sleep(self._rng.uniform(1.0, 2.0))
        except Exception as e:
            log.debug(f"[AccountMgr] _click_next error: {e}")

    # ── Account persistence ───────────────────────────────────────────────────

    def _save_account(self, account: CreatedAccount) -> None:
        """Atomic save account to disk."""
        _ACCOUNT_DIR.mkdir(parents=True, exist_ok=True)
        safe_id = "".join(
            c for c in account.profile_id[:12] if c.isalnum() or c in "-_"
        )
        p   = _ACCOUNT_DIR / f"{safe_id}.json"
        tmp = _ACCOUNT_DIR / f"{safe_id}.tmp"
        try:
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(account.to_dict(), f, indent=2)
            tmp.replace(p)
            log.info(f"[AccountMgr] Account saved: {p.name}")
        except Exception as e:
            log.warning(f"[AccountMgr] Save error: {e}")

    def load_account(self, profile_id: str) -> Optional[CreatedAccount]:
        """Load saved account for a profile."""
        safe_id = "".join(
            c for c in profile_id[:12] if c.isalnum() or c in "-_"
        )
        p = _ACCOUNT_DIR / f"{safe_id}.json"
        try:
            if p.exists():
                with open(p, "r", encoding="utf-8") as f:
                    data = json.load(f)
                return CreatedAccount(**data)
        except Exception as e:
            log.debug(f"[AccountMgr] Load error: {e}")
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
