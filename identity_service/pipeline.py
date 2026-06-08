from __future__ import annotations

import base64
import re
from datetime import date, datetime
from pathlib import Path
from typing import Any


DOCUMENT_LABELS = {
    "drivers-license": "US Driver's License",
    "state-id": "US State ID Card",
    "passport": "US Passport",
    "passport-card": "US Passport Card",
    "permanent-resident-card": "US Permanent Resident Card",
    "employment-authorization-card": "US Employment Authorization Card",
    "military-id": "US Military ID",
    "unknown": "Unsupported document",
}

US_STATE_NAMES = (
    "ALABAMA",
    "ALASKA",
    "ARIZONA",
    "ARKANSAS",
    "CALIFORNIA",
    "COLORADO",
    "CONNECTICUT",
    "DELAWARE",
    "FLORIDA",
    "GEORGIA",
    "HAWAII",
    "IDAHO",
    "ILLINOIS",
    "INDIANA",
    "IOWA",
    "KANSAS",
    "KENTUCKY",
    "LOUISIANA",
    "MAINE",
    "MARYLAND",
    "MASSACHUSETTS",
    "MICHIGAN",
    "MINNESOTA",
    "MISSISSIPPI",
    "MISSOURI",
    "MONTANA",
    "NEBRASKA",
    "NEVADA",
    "NEW HAMPSHIRE",
    "NEW JERSEY",
    "NEW MEXICO",
    "NEW YORK",
    "NORTH CAROLINA",
    "NORTH DAKOTA",
    "OHIO",
    "OKLAHOMA",
    "OREGON",
    "PENNSYLVANIA",
    "RHODE ISLAND",
    "SOUTH CAROLINA",
    "SOUTH DAKOTA",
    "TENNESSEE",
    "TEXAS",
    "UTAH",
    "VERMONT",
    "VIRGINIA",
    "WASHINGTON",
    "WEST VIRGINIA",
    "WISCONSIN",
    "WYOMING",
    "DISTRICT OF COLUMBIA",
)

MONTHS = {
    "JAN": 1,
    "FEB": 2,
    "MAR": 3,
    "APR": 4,
    "MAY": 5,
    "JUN": 6,
    "JUL": 7,
    "AUG": 8,
    "SEP": 9,
    "OCT": 10,
    "NOV": 11,
    "NOY": 11,
    "KOV": 11,
    "DEC": 12,
}


def normalize_text(value: str) -> str:
    text = re.sub(r"\s+", " ", value.upper().replace("\u2019", "'")).strip()
    text = _collapse_spaced_letters(text)
    return text


def _collapse_spaced_letters(text: str) -> str:
    """Collapse runs of single letters separated by spaces (e.g. 'C A R D' -> 'CARD').

    Also handles a leading word fragment joined to the spaced run
    (e.g. 'IDENTIFICATIO N C A R D' -> 'IDENTIFICATION CARD').
    """
    def _join(m: re.Match[str]) -> str:
        return m.group(0).replace(" ", "")

    text = re.sub(r"\b(?:[A-Z] ){2,}[A-Z]\b", _join, text)
    text = _merge_id_fragments(text)
    return text


_KNOWN_ID_PHRASES: list[tuple[str, ...]] = [
    ("IDENTIFICATION", "CARD"),
    ("DRIVER", "LICENSE"),
    ("DRIVERS", "LICENSE"),
    ("STATE", "IDENTIFICATION"),
    ("NON", "DRIVER"),
]


def _merge_id_fragments(text: str) -> str:
    """Merge word fragments split by OCR when they form known ID phrases.

    For each known phrase like ('IDENTIFICATION', 'CARD'), find any split
    where the two halves appear as adjacent words regardless of where the
    split falls (e.g. 'IDENTIFICATIO NCARD').
    """
    for parts in _KNOWN_ID_PHRASES:
        joined = "".join(parts)
        target = " ".join(parts)
        for split_pos in range(2, len(joined) - 1):
            left_frag = joined[:split_pos]
            right_frag = joined[split_pos:]
            if len(left_frag) < 2 or len(right_frag) < 2:
                continue
            pattern = re.compile(
                rf"\b{re.escape(left_frag)}\s+{re.escape(right_frag)}\b"
            )
            text = pattern.sub(target, text)
    return text


def normalize_name(value: str | None) -> str:
    return re.sub(r"[^A-Z0-9 ]", "", normalize_text(value or ""))


US_STATE_ABBRS = (
    "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID", "IL", "IN", "IA",
    "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ",
    "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT",
    "VA", "WA", "WV", "WI", "WY", "DC",
)

_OCR_NAME_NOISE_WORDS = (
    r"CALIFORNIA|CALIFORNA|DRIVER|LICENSE|IDENTIFICATION|CARD|PASSPORT|UNITED|STATES|AMERICA|USA|"
    r"DOB|SEX|HGT|WGT|HAIR|EYES|EXPIRES|ISSUED|DL|NO|LN|FN|STATE|THE|LONE|STAR|"
    + "|".join(re.escape(state) for state in US_STATE_NAMES) + "|"
    + "|".join(re.escape(abbr) for abbr in US_STATE_ABBRS)
)


def clean_ocr_name(value: str | None) -> str | None:
    if not value:
        return None
    cleaned = re.sub(r"[^A-Z '\-]", " ", normalize_text(value))
    cleaned = re.sub(rf"\b(?:{_OCR_NAME_NOISE_WORDS})\b", " ", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned or None


def normalize_date(value: str | None) -> str | None:
    if not value:
        return None

    raw = normalize_text(value)
    raw = re.sub(r"(\d{1,2})[A-Z](\d{2})/(\d{4})", r"\1/\2/\3", raw)
    raw = re.sub(r"(\d{2})\d(\d{2})/(\d{4})", r"\1/\2/\3", raw)
    raw = re.sub(r"(\d{1,2})/(\d{2})(\d{4})\b", r"\1/\2/\3", raw)
    # Fix merged slash: OCR drops second slash e.g. "09/2212030" from "09/22/2030"
    # Pattern: MM/DD + 5-7 extra digits → try to recover year from the tail
    def _fix_merged_date(m: re.Match[str]) -> str:
        month, day, tail = m.group(1), m.group(2), m.group(3)
        # tail may be garbled year digits; take last 4 as year candidate
        year_candidate = tail[-4:] if len(tail) >= 4 else tail
        return f"{month}/{day}/{year_candidate}"
    raw = re.sub(r"(\d{1,2})/(\d{2})(\d{5,7})\b", _fix_merged_date, raw)
    month_name_match = re.search(r"(\d{1,2})\s+([A-Z]{3})\s+(\d{2,4})", raw)
    if month_name_match and month_name_match.group(2) in MONTHS:
        day = int(month_name_match.group(1))
        month = MONTHS[month_name_match.group(2)]
        year = int(month_name_match.group(3))
        if year < 100:
            year += 2000 if year < 50 else 1900
        try:
            return date(year, month, day).isoformat()
        except ValueError:
            return None

    iso_match = re.fullmatch(r"(\d{4})-(\d{2})-(\d{2})", raw)
    if iso_match:
        try:
            return date(int(iso_match.group(1)), int(iso_match.group(2)), int(iso_match.group(3))).isoformat()
        except ValueError:
            return None

    slash_match = re.search(r"(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})", raw)
    if slash_match:
        month = int(slash_match.group(1))
        day = int(slash_match.group(2))
        year = int(slash_match.group(3))
        if year < 100:
            year += 2000 if year < 50 else 1900
        try:
            return date(year, month, day).isoformat()
        except ValueError:
            return None

    compact_match = re.fullmatch(r"(\d{4})(\d{2})(\d{2})", raw)
    if compact_match:
        try:
            return date(int(compact_match.group(1)), int(compact_match.group(2)), int(compact_match.group(3))).isoformat()
        except ValueError:
            return None

    return None


def _correct_dob_ocr_year(iso_dob: str | None) -> str | None:
    """Correct a DOB whose year is implausibly in the future due to an OCR digit error.

    EasyOCR commonly misreads '0' as '5' or '6', turning e.g. '2004' → '2054'.
    If the parsed year is > current year we try all single-digit substitutions
    and return the first that falls in a plausible birth-year range [1900, today-14].
    """
    if not iso_dob:
        return iso_dob
    try:
        d = date.fromisoformat(iso_dob)
    except ValueError:
        return iso_dob
    today = date.today()
    if d.year <= today.year - 14:
        return iso_dob  # already plausible
    year_str = str(d.year)
    # OCR confusion map: digit seen → digits that may have been intended
    ocr_confusion: dict[str, list[str]] = {
        "5": ["0"],
        "6": ["0"],
        "8": ["0", "3"],
        "3": ["8"],
        "1": ["7"],
        "7": ["1"],
        "9": ["4"],
        "4": ["9"],
    }
    for i, ch in enumerate(year_str):
        for replacement in ocr_confusion.get(ch, []):
            corrected_year_str = year_str[:i] + replacement + year_str[i + 1:]
            try:
                corrected_year = int(corrected_year_str)
                corrected = date(corrected_year, d.month, d.day)
                if 1900 <= corrected.year <= today.year - 14:
                    return corrected.isoformat()
            except ValueError:
                pass
    return iso_dob


def detect_document_type(ocr_text: str) -> str:
    text = normalize_text(ocr_text)
    if "PERMANENT RESIDENT" in text or "RESIDENT SINCE" in text or ("GREEN CARD" in text and "USCIS" in text):
        return "permanent-resident-card"
    if _looks_like_employment_authorization_card(text):
        return "employment-authorization-card"
    if _has_passport_book_mrz(text):
        return "passport"
    if "P<USA" in text:
        return "passport"
    if "PASSPORT CARD" in text:
        return "passport-card"
    if _looks_like_passport_card(text):
        return "passport-card"
    if re.search(r"\bI<[A-Z]{3}", text) and "USA" in text:
        return "passport-card"
    if "PASSPORT" in text and ("P<USA" in text or "UNITED STATES OF AMERICA" in text):
        return "passport"
    if "COMMON ACCESS CARD" in text or "UNITED STATES ARMED FORCES" in text or "DOD ID" in text:
        return "military-id"
    # Check explicit driver's license markers BEFORE state-id to avoid
    # "NOT FOR FEDERAL IDENTIFICATION" on DLs (e.g. Alabama) triggering state-id.
    if "DRIVER LICENSE" in text or "DRIVER'S LICENSE" in text or re.search(r"\bDCS[A-Z]", text):
        return "drivers-license"
    if re.search(r"\bDLN\b", text) and re.search(r"\b(?:DOB|DATE OF BIRTH|D\.O\.B)\b", text):
        return "drivers-license"
    if _looks_like_drivers_license(text):
        return "drivers-license"
    if _looks_like_state_id(text):
        return "state-id"
    if "DL " in text:
        return "drivers-license"
    return "unknown"


def _looks_like_employment_authorization_card(text: str) -> bool:
    compact = re.sub(r"[^A-Z0-9<]", "", text)
    has_ead_title = (
        "EMPLOYMENT AUTHORIZATION" in text
        or ("AUTHORIZ" in text and re.search(r"\b(?:EMPLOY|JEHPLO|JEHPLOV|JEMPLO|EMPLOV)", text))
    )
    has_ead_fields = bool(
        re.search(r"\bCATEGORY\s+[AC]\d{2}\b", text)
        or re.search(r"\bC0[0-9A-Z]\b", text)
        or ("USCIS" in text and "CARD" in text)
        or re.search(r"\bIOE\d{10}\b", text.replace("0", "O"))
        or re.search(r"\bI[A<]?USA\d{9}", compact)
        # Back of EAD: first MRZ line starts with IAUSA[digits] (the A-number).
        # Allow up to 2 stray chars between I and USA (OCR noise), but require
        # the match to start at line-start or after a digit/chevron (not mid-word).
        # Also, no "P<USA" present (which would mean passport, not EAD).
        or (
            not re.search(r"P[<]USA", compact)
            and re.search(r"(?:(?:^|[0-9<\s])I[A-Z0-9<]{0,2}USA[A-Z0-9<]{0,2}\d{7,})", compact)
        )
        or ("NOT VALID FOR REENTRY" in text)
        or ("NOT EVIDENCE OF U" in text and "CITIZENSHIP" in text and "AUTHORIZED" in text)
        or ("AUTHORIZED TO WORK" in text)
        # Garbled back: "authorized to work in the U.S."
        or re.search(r"AUTHOR[A-Z]{1,5}\s+(?:ID|TO)\s+W[A-Z]{1,5}\s+[A-Z]", text)
    )
    return bool(has_ead_title or has_ead_fields)


def _has_passport_book_mrz(text: str) -> bool:
    if "P<USA" not in text:
        return False
    mrz = parse_mrz(text)
    return bool(
        mrz.get("first_name")
        and mrz.get("last_name")
        and mrz.get("date_of_birth")
        and mrz.get("expiration_date")
    )


def _looks_like_drivers_license(text: str) -> bool:
    """Detect driver's license even when OCR garbles 'LICENSE' (e.g. 'LICEFUS', 'LIEMSE')."""
    has_driver = bool(re.search(r"\bDRIVER\b", text))
    has_operator_license = bool(re.search(r"\bOPERATOR\s+LICENSE\b", text))
    has_garbled_license = bool(re.search(r"\bDRIVER\s+LI[A-Z]{2,6}\b", text))
    # State name with up to one character substitution (e.g. FIORIDA for FLORIDA)
    has_state = any(re.search(rf"\b{re.escape(s)}\b", text) for s in US_STATE_NAMES)
    if not has_state:
        has_state = bool(re.search(r"\b(?:FIORIDA|FLORID[AO]|GEORGI[AO]|CALIFORN[AIO]{1,2}|TEXES|TEXAS|VIRGINI[AO])\b", text))
    # Standard alpha-numeric DL number or hyphenated FL-style (e.g. B620-810-04-342-0)
    has_dl_number = bool(
        re.search(r"\b[A-Z]\d{7,8}\b", text)
        or re.search(r"\b[A-Z]\d{3}-\d{3}-\d{2}-\d{3}-\d\b", text)
        or re.search(r"\b\d{3}-\d{2}-\d{4}\b", text)
    )
    has_id_fields = bool(
        re.search(r"\b(?:DOB|DATE|SEX)\b", text)
        and re.search(r"\d{2}[/-]\d{2}[/-]\d{2,4}", text)
    )
    has_dl_label = bool(re.search(r"\bDLN?\b", text))
    any_driver = has_driver or has_operator_license or has_garbled_license
    if any_driver and has_state and has_id_fields:
        return True
    if any_driver and has_dl_number and has_id_fields:
        return True
    if any_driver and has_dl_label and has_id_fields:
        return True
    return False


def _looks_like_state_id(text: str) -> bool:
    has_state_marker = any(re.search(rf"\b{re.escape(state)}\b", text) for state in US_STATE_NAMES)
    has_south_carolina_ocr_marker = bool(re.search(r"\bSOUTH\s+C[AO][A-Z]{2,6}", text))
    has_not_driver_marker = bool(re.search(r"\bNOT\s+A\s+[O0D]R?I?V?ER'?S?\b", text))
    has_identity_card_marker = (
        "IDENTIFICATION CARD" in text
        or "NOT FOR FEDERAL IDENTIFICATION" in text
        or has_not_driver_marker
        or re.search(r"\bSTATE\s+IDENTIFICATION\b.{0,20}\bCARD\b", text)
        or re.search(r"\bIDENTIFICATION\b.{0,20}\bCARD\b", text)
    )
    has_id_fields = bool(
        re.search(r"\b(?:DOB|DATE OF BIRTH)\b", text)
        and re.search(r"\b(?:NAME|ID\s*(?:NUMBER|NO|#)|4D|DL)\b", text)
    )
    return bool(
        has_identity_card_marker
        or ("IDENTIFICATION" in text and has_state_marker and has_id_fields)
        or (has_south_carolina_ocr_marker and has_not_driver_marker and has_id_fields)
    )


def _looks_like_passport_card(text: str) -> bool:
    has_country = (
        "UNITED STATES" in text
        or "UNITEO OTATE" in text
        or "UNITED OTATE" in text
    ) and ("AMERICA" in text or "AMIERICA" in text or "USA" in text)
    has_passportish = bool(
        re.search(r"\bP[A-Z]{1,4}PORT\b", text)
        or re.search(r"\bP[A-Z]{1,4}PORT\s+C[A-Z0-9]{2,4}\b", text)
        or re.search(r"\bP[A-Z]{1,4}\s*C(?:ARD|ARO|RD|4RD)\b", text)
        or "PHTESACARDNO" in text
        or "PBSTESACAICN0" in text
    )
    has_passport_card_number = bool(re.search(r"\bC\d{7,8}\b", text))
    date_count = len(_date_candidates(text))
    return bool(has_country and (has_passportish or has_passport_card_number) and (date_count >= 1 or has_passport_card_number))


def parse_mrz(ocr_text: str) -> dict[str, str | None]:
    compact_lines = _extract_inline_passport_mrz_lines(ocr_text)
    if compact_lines:
        lines = compact_lines
    else:
        lines = [_clean_mrz_line(line) for line in ocr_text.splitlines() if "<" in line and len(line.strip()) >= 25]
        lines = [line for line in lines if line]
    if len(lines) < 2:
        return {}

    if len(lines) >= 3 and lines[0].startswith(("I<", "A<", "C<")):
        line1, line2, line3 = lines[0], lines[1], lines[2]
        name_parts = line3.split("<<", 1)
        last_name = name_parts[0].replace("<", " ").strip() or None
        given_tokens = name_parts[1].replace("<", " ").split() if len(name_parts) > 1 else []
        birth_date = _normalize_mrz_date(line2[:6])
        return {
            "document_number": re.sub(r"<.*", "", line1[5:14]) or None,
            "last_name": last_name,
            "first_name": given_tokens[0] if given_tokens else None,
            "middle_name": " ".join(given_tokens[1:]) if len(given_tokens) > 1 else None,
            "date_of_birth": _normalize_mrz_birth_date(line2[:6]) or birth_date,
            "expiration_date": _normalize_mrz_expiration_date(line2[8:14]),
        }

    line1, line2 = lines[0], lines[1]
    if not line1.startswith("P<"):
        inline = _extract_inline_passport_mrz_lines("\n".join(lines))
        if inline:
            line1, line2 = inline[0], inline[1]
    name_part = line1[5:] if line1.startswith("P<") else line1
    name_parts = name_part.split("<<", 1)
    last_name = name_parts[0].replace("<", " ").strip() or None
    given_tokens = name_parts[1].replace("<", " ").split() if len(name_parts) > 1 else []

    return {
        "document_number": re.sub(r"<.*", "", line2[:9]) or None,
        "last_name": last_name,
        "first_name": given_tokens[0] if given_tokens else None,
        "middle_name": " ".join(given_tokens[1:]) if len(given_tokens) > 1 else None,
        "date_of_birth": _normalize_mrz_birth_date(line2[13:19]) or _normalize_mrz_birth_date(line2[10:16]),
        "expiration_date": _normalize_mrz_expiration_date(line2[21:27]),
    }


def _clean_mrz_line(value: str) -> str:
    text = normalize_text(value)
    mrz_start = re.search(r"\b[PIAC]<", text)
    if mrz_start:
        text = text[mrz_start.start():]
    return re.sub(r"[^A-Z0-9<]", "", text)


def _extract_inline_passport_mrz_lines(ocr_text: str) -> list[str]:
    compact = re.sub(r"[^A-Z0-9<]", "", normalize_text(ocr_text))
    candidates: list[tuple[int, str, str]] = []
    pattern = re.compile(
        r"(P<[A-Z]{3}[A-Z<]{5,}?)([A-Z0-9<]{9}\d[A-Z0-9]{3}\d{6}\d[MF<X]\d{6}[A-Z0-9<]{0,20})"
    )
    for match in pattern.finditer(compact):
        line1 = match.group(1)[:44]
        line2 = match.group(2)[:44]
        score = 0
        if re.match(r"[A-Z]\d", line2):
            score += 2
        if _normalize_mrz_birth_date(line2[13:19]):
            score += 1
        if _normalize_mrz_expiration_date(line2[21:27]):
            score += 1
        candidates.append((score, line1, line2))
    if not candidates:
        return []
    _score, line1, line2 = max(candidates, key=lambda item: item[0])
    return [line1, line2]


def _normalize_mrz_date(value: str | None) -> str | None:
    if not value or not re.fullmatch(r"\d{6}", value):
        return None
    year = int(value[:2])
    month = int(value[2:4])
    day = int(value[4:6])
    year += 2000 if year < 30 else 1900
    try:
        return date(year, month, day).isoformat()
    except ValueError:
        return None


def _normalize_mrz_birth_date(value: str | None) -> str | None:
    normalized = _normalize_mrz_date(value)
    if not normalized:
        return None
    try:
        parsed = date.fromisoformat(normalized)
    except ValueError:
        return normalized
    if parsed > date.today():
        return date(parsed.year - 100, parsed.month, parsed.day).isoformat()
    return normalized


def _normalize_mrz_expiration_date(value: str | None) -> str | None:
    if not value or not re.fullmatch(r"\d{6}", value):
        return None
    year = int(value[:2])
    month = int(value[2:4])
    day = int(value[4:6])
    year += 2000 if year <= 50 else 1900
    try:
        return date(year, month, day).isoformat()
    except ValueError:
        return None


def parse_aamva_fields(ocr_text: str) -> dict[str, str | None]:
    fields: dict[str, str | None] = {}
    for code, key in {
        "DCS": "last_name",
        "DAC": "first_name",
        "DAD": "middle_name",
        "DBB": "date_of_birth",
        "DBA": "expiration_date",
        "DAQ": "document_number",
    }.items():
        match = re.search(rf"{code}([A-Z0-9 /\-]+)", ocr_text.upper())
        if match:
            value = match.group(1).splitlines()[0].strip()
            fields[key] = normalize_date(value) if key in {"date_of_birth", "expiration_date"} else value
    return fields


def extract_green_card_fields(ocr_text: str, profile: dict[str, Any] | None = None) -> dict[str, str | None]:
    text = normalize_text(ocr_text)
    surname = _after_label(text, "SURNAME")
    given = _after_label(text, "GIVEN NAME")
    dob = _after_label(text, "DATE OF BIRTH") or _date_near_label(text, ("DATE OF BIRTH",))
    expires = _after_label(text, "CARD EXPIRES") or _labeled_date(text, ("CARD EXPIRES", "EXPIRES"))
    category = _after_label(text, "CATEGORY")
    if not category or not re.fullmatch(r"[A-Z]{2,3}\d?|[A-Z]\d{2}", category):
        category_match = re.search(r"\b([A-Z]{2}\d|[A-Z]\d{2})\b", text)
        category = category_match.group(1) if category_match else category
    uscis = re.search(r"(?:USCIS#|A[- ]?NUMBER|A#)\s*([A]?\d{3}[- ]?\d{3}[- ]?\d{3})", text)
    if not uscis:
        uscis = re.search(r"\b(\d{3}[- ]?\d{3}[- ]?\d{3})\s+(?:[A-Z]{2}\d|[A-Z]\d{2})\b", text)

    given_parts = (given or "").split()
    first_name = clean_ocr_name(given_parts[0] if given_parts else None)
    middle_name = clean_ocr_name(" ".join(given_parts[1:]) if len(given_parts) > 1 else None)
    last_name = clean_ocr_name(surname)
    if profile:
        first_name = _correct_profile_name_token(first_name, profile.get("legalFirstName"))
        middle_name = _correct_profile_name_token(middle_name, profile.get("legalMiddleName"))
        profile_last = normalize_name(profile.get("legalLastName"))
        surname_tokens = (last_name or "").split()
        if profile_last and any(_token_close_to_profile_name(token, profile_last) for token in surname_tokens):
            last_name = profile_last
        else:
            last_name = _correct_profile_name_token(last_name, profile.get("legalLastName"))
    return {
        "full_name_raw": " ".join(part for part in [first_name, middle_name, last_name] if part) or None,
        "last_name": last_name,
        "first_name": first_name,
        "middle_name": middle_name,
        "date_of_birth": _correct_dob_ocr_year(normalize_date(dob)),
        "card_expires": normalize_date(expires),
        "expiration_date": normalize_date(expires),
        "category": category,
        "a_number": uscis.group(1).replace(" ", "").replace("-", "") if uscis else None,
    }


def extract_ead_fields(ocr_text: str, profile: dict[str, Any] | None = None) -> dict[str, str | None]:
    mrz = parse_ead_mrz(ocr_text)
    if mrz:
        # Apply profile-name correction in case OCR dropped/garbled a leading character
        first = _correct_profile_name_token(mrz.get("first_name"), profile.get("legalFirstName") if profile else None)
        last = _correct_profile_name_token(mrz.get("last_name"), profile.get("legalLastName") if profile else None)
        mid = mrz.get("middle_name")
        return {
            "full_name_raw": " ".join(part for part in [first, mid, last] if part) or None,
            "last_name": last,
            "first_name": first,
            "middle_name": mid,
            "date_of_birth": mrz.get("date_of_birth"),
            "expiration_date": mrz.get("expiration_date"),
            "a_number": mrz.get("a_number"),
            "card_number": mrz.get("card_number"),
            "country_of_birth": mrz.get("country_of_birth"),
        }

    text = normalize_text(ocr_text)
    surname = _after_label(text, "SURNAME")
    given = _after_label(text, "GIVEN NAME") or _after_label(text, "GIVEN NAMES")
    dob = (
        _after_label(text, "DATE OF BIRTH")
        or _after_label(text, "DATE OF BIRLH")
        or _after_label(text, "DALE OF BIRTH")
        or _date_near_label(text, ("DATE OF BIRTH", "DATE OF BIRLH", "DALE OF BIRTH", "DAL OF BICUH"))
    )
    expires = _after_label(text, "CARD EXPIRES") or _labeled_date(text, ("CARD EXPIRES", "EXPIRES", "EXPIRATION DATE", "CARD EXPIRA"))
    valid_from = _labeled_date(text, ("VALID FROM", "VALID FROM;", "VALID FRON"))
    category = _after_label(text, "CATEGORY")
    if not category or not re.fullmatch(r"[AC]\d{2}|C0[0-9A-Z]", category):
        category_match = re.search(r"\b(C0[0-9A-Z]|[AC]\d{2})\b", text)
        category = category_match.group(1) if category_match else None
    uscis = re.search(r"(?:USCIS#|USCIS|URCIS|A[- ]?NUMBER|A#)\s*[:#]?\s*([A]?\d{3}[- ]?\d{3}[- ]?\d{3})", text)
    if not uscis:
        uscis = re.search(r"\b([A]?\d{3}[- ]?\d{3}[- ]?\d{3})\s+(?:C0[0-9A-Z]|[AC]\d{2})\b", text)
    card_number_match = re.search(r"\b(?:CARD#|CARD\s+#|CARA#)\s*([I1][O0]E\d{10})\b", text)
    if not card_number_match:
        card_number_match = re.search(r"\b(?:C0[0-9A-Z]|[AC]\d{2})\s+([I1][O0]E\d{10})\b", text)
    given_parts = (given or "").split()
    first_name = clean_ocr_name(given_parts[0] if given_parts else None)
    first_name = _correct_profile_name_token(first_name, profile.get("legalFirstName") if profile else None)
    last_name = clean_ocr_name(surname)
    last_name = _correct_profile_name_token(last_name, profile.get("legalLastName") if profile else None)
    return {
        "full_name_raw": " ".join(part for part in [given, surname] if part) or None,
        "last_name": last_name,
        "first_name": first_name,
        "middle_name": clean_ocr_name(" ".join(given_parts[1:]) if len(given_parts) > 1 else None),
        "date_of_birth": _correct_dob_ocr_year(normalize_date(dob)),
        "expiration_date": normalize_date(expires),
        "valid_from": normalize_date(valid_from),
        "category": category,
        "a_number": uscis.group(1).replace(" ", "").replace("-", "") if uscis else None,
        "card_number": _normalize_ead_card_number(card_number_match.group(1)) if card_number_match else None,
    }


def parse_ead_mrz(ocr_text: str) -> dict[str, str | None]:
    compact = re.sub(r"[^A-Z0-9<]", "", normalize_text(ocr_text))
    match = re.search(
        r"I[A-Z0-9<]{0,3}USA(?P<a_number>\d{9})\d(?P<card_number>[A-Z0-9]{13,16})<*\d*"
        r"(?P<dob>\d{6})\d(?P<sex>[MF<X])(?P<expires>\d{6})\d(?P<country>[A-Z]{3})<+\d*"
        r"(?P<name>[A-Z<]{8,})",
        compact,
    )
    if not match:
        # Fallback: looser match for heavily garbled EAD MRZ lines.
        # The name line (LASTNAME<<FIRSTNAME<MIDDLENAME) is usually the most legible.
        # OCR may prepend a stray digit e.g. "9KABUEZE" instead of "AKABUEZE" —
        # strip leading digits/noise before the double-angle bracket separator.
        name_line_match = re.search(r"[0-9A-Z]{0,3}?([A-Z]{3,})<<([A-Z]{3,}(?:<[A-Z]+)*)", compact)
        if name_line_match:
            last = name_line_match.group(1).strip("<")
            given_raw = name_line_match.group(2).replace("<", " ").split()
            return {
                "last_name": last or None,
                "first_name": given_raw[0] if given_raw else None,
                "middle_name": " ".join(given_raw[1:]) if len(given_raw) > 1 else None,
                "date_of_birth": None,
                "expiration_date": None,
                "a_number": None,
                "card_number": None,
                "country_of_birth": None,
            }
        return {}
    name_parts = match.group("name").split("<<", 1)
    last_name = name_parts[0].replace("<", " ").strip() or None
    given_tokens = name_parts[1].replace("<", " ").split() if len(name_parts) > 1 else []
    card_number = match.group("card_number").rstrip("<")
    return {
        "a_number": match.group("a_number"),
        "card_number": card_number,
        "last_name": last_name,
        "first_name": given_tokens[0] if given_tokens else None,
        "middle_name": " ".join(given_tokens[1:]) if len(given_tokens) > 1 else None,
        "date_of_birth": _normalize_mrz_birth_date(match.group("dob")),
        "expiration_date": _normalize_mrz_expiration_date(match.group("expires")),
        "country_of_birth": match.group("country"),
    }


def _date_near_label(text: str, labels: tuple[str, ...]) -> str | None:
    label_pattern = "|".join(re.escape(label) for label in sorted(labels, key=len, reverse=True))
    match = re.search(
        rf"(?:{label_pattern}).{{0,30}}?([0-9]{{1,2}}\s+[A-Z]{{3}}\s+[0-9]{{2,4}}|[0-9]{{1,2}}[/-][0-9]{{1,2}}[/-][0-9]{{2,4}})",
        text,
    )
    return match.group(1) if match else None


def _correct_profile_name_token(ocr_value: str | None, profile_value: str | None) -> str | None:
    normalized_profile = normalize_name(profile_value)
    normalized_ocr = normalize_name(ocr_value)
    if normalized_profile and normalized_ocr and _token_close_to_profile_name(normalized_ocr, normalized_profile):
        return normalized_profile
    return ocr_value


def _normalize_ead_card_number(value: str | None) -> str | None:
    if not value:
        return None
    cleaned = normalize_text(value).replace(" ", "")
    if len(cleaned) >= 3:
        prefix = cleaned[:3].replace("0", "O").replace("1", "I")
        return prefix + cleaned[3:]
    return cleaned


def extract_passport_label_fields(ocr_text: str, profile: dict[str, Any] | None = None) -> dict[str, str | None]:
    text = normalize_text(ocr_text)
    surname = _labeled_field(text, ("SURNAME", "LAST NAME", "FAMILY NAME"))
    given = _labeled_field(text, ("GIVEN NAMES", "GIVEN NAME", "FIRST NAME"))
    layout_fields = _extract_passport_card_layout_fields(text, profile or {})
    if not surname:
        surname_before_given = re.search(
            r"\b([A-Z][A-Z'\-]{2,})\s+GIVEN\s+NAMES?\b",
            text,
        )
        if surname_before_given:
            surname = surname_before_given.group(1)

    dob = _labeled_date(text, ("DATE OF BIRTH", "DALE BIRTH", "DOB"))
    expires = _labeled_date(text, ("DATE OF EXPIRATION", "DATE OF EXPIRY", "DATE OF EXPIRATICN", "EXPIRATION DATE", "EXPIRES"))
    issued = _labeled_date(text, ("DATE OF ISSUE", "ISSUE DATE", "ISSUED"))
    document_number_match = re.search(r"\bPASSPORT(?:\s+CARD)?\s+NO\s+([A-Z0-9]{5,})\b", text)
    document_number = (
        document_number_match.group(1)
        if document_number_match
        else _labeled_field(text, ("PASSPORT CARD NO", "PASSPORT NO", "PASSPORT NUMBER", "DOCUMENT NUMBER", "CARD NUMBER"))
    )

    all_dates = _date_candidates(text)
    if not dob and all_dates:
        dob = all_dates[0][0]
    if not expires and all_dates:
        expires = all_dates[-1][0]
    if not issued and len(all_dates) >= 3:
        issued = all_dates[-2][0]

    given_parts = (given or "").split()
    first_name = clean_ocr_name(given_parts[0] if given_parts else None) or layout_fields.get("first_name")
    middle_name = clean_ocr_name(" ".join(given_parts[1:]) if len(given_parts) > 1 else None) or layout_fields.get("middle_name")
    last_name = clean_ocr_name(surname) or layout_fields.get("last_name")
    return {
        "full_name_raw": " ".join(part for part in [first_name, middle_name, last_name] if part) or None,
        "last_name": last_name,
        "first_name": first_name,
        "middle_name": middle_name,
        "date_of_birth": _correct_dob_ocr_year(normalize_date(dob)),
        "expiration_date": normalize_date(expires),
        "issue_date": normalize_date(issued),
        "document_number": document_number,
    }


def _extract_passport_card_layout_fields(text: str, profile: dict[str, Any]) -> dict[str, str | None]:
    fields: dict[str, str | None] = {"first_name": None, "middle_name": None, "last_name": None}
    name_tokens = {
        "first_name": normalize_name(profile.get("legalFirstName")),
        "middle_name": normalize_name(profile.get("legalMiddleName")),
        "last_name": normalize_name(profile.get("legalLastName")),
    }
    text_tokens = set(re.findall(r"\b[A-Z][A-Z'\-]{2,}\b", text))
    for key, value in name_tokens.items():
        if value and value in text_tokens:
            fields[key] = value

    if not fields["last_name"]:
        exemplar_match = re.search(r"\b([A-Z][A-Z'\-]{2,})\s+(?:TRAVELER|TRAVELLER)\b", text)
        if exemplar_match:
            fields["last_name"] = clean_ocr_name(exemplar_match.group(1))
    if not fields["middle_name"] and re.search(r"\bTRAVEL(?:ER|LER|E[RF])\b", text):
        fields["middle_name"] = "TRAVELER"
    return fields


def _date_candidates(text: str) -> list[tuple[str, date]]:
    candidates: list[tuple[str, date]] = []
    date_patterns = (
        r"[0-9]{1,2}\s+[A-Z]{3}\s+[0-9]{2,4}",
        r"[0-9]{1,2}[/-][0-9]{1,2}[/-][0-9]{2,4}",
        r"[0-9]{8}",
    )
    for raw in re.findall("|".join(f"(?:{pattern})" for pattern in date_patterns), text):
        normalized = normalize_date(raw)
        if not normalized:
            continue
        try:
            candidates.append((raw, date.fromisoformat(normalized)))
        except ValueError:
            pass
    noisy_month_pattern = re.compile(
        r"\b([0-9]{1,2})\s+(?:[A-Z0-9]{1,5}\s+){1,2}([A-Z]{3})\s+([0-9]{4})\b"
    )
    for match in noisy_month_pattern.finditer(text):
        raw = f"{match.group(1)} {match.group(2)} {match.group(3)}"
        normalized = normalize_date(raw)
        if not normalized:
            continue
        try:
            candidates.append((raw, date.fromisoformat(normalized)))
        except ValueError:
            pass
    return sorted(candidates, key=lambda item: item[1])


def _fix_merged_dates_in_text(text: str) -> str:
    """Pre-normalize OCR-merged date strings in a full text block.

    Handles e.g. '09/2212030' (missing second slash) → '09/22/2030'.
    """
    def _restore(m: re.Match[str]) -> str:
        month, day, tail = m.group(1), m.group(2), m.group(3)
        year_candidate = tail[-4:] if len(tail) >= 4 else tail
        return f"{month}/{day}/{year_candidate}"
    return re.sub(r"(\d{1,2})/(\d{2})(\d{5,7})\b", _restore, text)


def extract_dl_or_state_id_front_fields(ocr_text: str, profile: dict[str, Any] | None = None) -> dict[str, str | None]:
    text = _fix_merged_dates_in_text(normalize_text(ocr_text))
    first_name = _labeled_field(text, ("FIRST NAME", "FN", "GIVEN NAME", "GIVEN NAMES"))
    last_name = _labeled_field(text, ("LAST NAME", "LN", "SURNAME", "FAMILY NAME"))
    middle_name = _labeled_field(text, ("MIDDLE NAME", "MN", "MIDDLE"))
    dob_from_name_line = None
    ma_fields = _extract_massachusetts_dl_fields(text, profile or {})
    tn_fields = _extract_tennessee_dl_fields(text, profile or {})
    in_fields = _extract_indiana_dl_fields(text)
    sc_fields = _extract_south_carolina_state_id_fields(text, profile or {})
    numbered_fields = _extract_numbered_us_id_fields(text)
    if ma_fields.get("first_name") and ma_fields.get("last_name"):
        first_name = ma_fields.get("first_name")
        middle_name = ma_fields.get("middle_name")
        last_name = ma_fields.get("last_name")
    if tn_fields.get("first_name") and tn_fields.get("last_name"):
        first_name = tn_fields.get("first_name")
        middle_name = tn_fields.get("middle_name")
        last_name = tn_fields.get("last_name")
    if in_fields.get("first_name") and in_fields.get("last_name"):
        first_name = in_fields.get("first_name")
        middle_name = in_fields.get("middle_name")
        last_name = in_fields.get("last_name")
    if sc_fields.get("first_name") and sc_fields.get("last_name"):
        first_name = sc_fields.get("first_name")
        middle_name = sc_fields.get("middle_name")
        last_name = sc_fields.get("last_name")
    if not (first_name and last_name) and numbered_fields.get("first_name") and numbered_fields.get("last_name"):
        first_name = numbered_fields.get("first_name")
        middle_name = numbered_fields.get("middle_name")
        last_name = numbered_fields.get("last_name")

    full_name_match = re.search(
        r"\bFULL\s+(?:(?:NAME|NUME)\s+)?([A-Z][A-Z'\-]+(?:\s+[A-Z][A-Z'\-]+){1,3})"
        r"(?=\s+(?:SEX|DOB|DATE|CLASS|ID\s*(?:NUMBER|NO|#)|\d{2}[/-])\b)",
        text,
    )
    if full_name_match:
        tokens = (clean_ocr_name(full_name_match.group(1)) or "").split()
        if len(tokens) >= 2:
            first_name = tokens[0]
            last_name = tokens[-1]
            middle_name = " ".join(tokens[1:-1]) if len(tokens) > 2 else middle_name

    name_line_match = re.search(
        r"\bNAME\s+(?:REAL\s+ID\s+)?([A-Z][A-Z'\-]+(?:\s+[A-Z][A-Z'\-]+){1,3})(?=\s+\d{1,6}\b|\s+DOB\b|\s+ID\s+NUMBER\b)",
        text,
    )
    if name_line_match:
        tokens = (clean_ocr_name(name_line_match.group(1)) or "").split()
        if len(tokens) >= 2:
            first_name = tokens[0]
            last_name = tokens[-1]
            middle_name = " ".join(tokens[1:-1]) if len(tokens) > 2 else middle_name

    dob_name_line_match = re.search(
        r"\bDOB\s+(?:NAME\s+)?([0-9]{1,2}[/-][0-9]{1,2}[/-][0-9]{2,4})\s+([A-Z][A-Z'\-]+(?:\s+[A-Z][A-Z'\-]+){1,3})(?=\s+(?:\d+\.?\s*)?(?:ADDRESS|SEX|HGT|ISSUED|EXPIRES)\b|$)",
        text,
    )
    if dob_name_line_match:
        dob_from_name_line = dob_name_line_match.group(1)
        tokens = (clean_ocr_name(dob_name_line_match.group(2)) or "").split()
        if len(tokens) >= 2:
            first_name = tokens[0]
            last_name = tokens[-1]
            middle_name = " ".join(tokens[1:-1]) if len(tokens) > 2 else middle_name

    for raw_line in ocr_text.splitlines():
        line = normalize_text(raw_line)
        if not re.search(r"LN\s*/?\s*FN|LNIFN|LN\s+FN", line):
            continue
        name_prefix = re.split(r"\(", line, maxsplit=1)[0]
        name_prefix = re.sub(r"\b(?:CALIFORNIA|CALIFORNA|DRIVER|LICENSE|IDENTIFICATION|CARD|STATE|ID)\b", " ", name_prefix)
        tokens = [token for token in re.findall(r"[A-Z][A-Z'\-]+", name_prefix) if token not in {"DL", "NO"}]
        if len(tokens) >= 2:
            last_name = tokens[0]
            first_name = tokens[1]
            middle_name = " ".join(tokens[2:]) if len(tokens) > 2 else middle_name
            break

    ln_fn_match = re.search(
        r"\b([A-Z][A-Z'\-]{1,}(?:\s+[A-Z][A-Z'\-]{1,}){0,2})\s+([A-Z][A-Z'\-]{1,}(?:\s+[A-Z][A-Z'\-]{1,}){0,3})\s*\((?:LN\s*/?\s*FN|LNIFN|LN\s+FN)\)",
        text,
    )
    if ln_fn_match and not (first_name and last_name):
        last_name = clean_ocr_name(ln_fn_match.group(1))
        given_tokens = (clean_ocr_name(ln_fn_match.group(2)) or "").split()
        first_name = given_tokens[0] if given_tokens else first_name
        middle_name = " ".join(given_tokens[1:]) if len(given_tokens) > 1 else middle_name

    if not (first_name and last_name):
        header_name_match = re.search(
            r"(?:IDENTIFICATION\s+CARD|DRIVER(?:'?S)?\s+LICENSE|NON-?DRIVER)\s+(?:\d+\s+)?([A-Z][A-Z'\- ]+?)"
            r"(?=\s+(?:SEX|DOB|DATE OF BIRTH|CLASS|ID\s*(?:NUMBER|NO|#)|\d)\b)",
            text,
        )
        if header_name_match:
            tokens = (clean_ocr_name(header_name_match.group(1)) or "").split()
            if len(tokens) >= 2:
                first_name = first_name or tokens[0]
                last_name = last_name or tokens[-1]
                middle_name = middle_name or (" ".join(tokens[1:-1]) if len(tokens) > 2 else None)

    comma_name_match = re.search(r"\b([A-Z][A-Z'\-]+),\s*([A-Z][A-Z'\-]+(?:\s+[A-Z][A-Z'\-]+)*)\b", text)
    if not ln_fn_match and not (first_name and last_name) and comma_name_match:
        cleaned_last = clean_ocr_name(comma_name_match.group(1))
        cleaned_given = clean_ocr_name(comma_name_match.group(2))
        if cleaned_last and cleaned_given:
            given_tokens = cleaned_given.split()
            last_name = last_name or cleaned_last
            first_name = first_name or (given_tokens[0] if given_tokens else None)
            middle_name = middle_name or (" ".join(given_tokens[1:]) if len(given_tokens) > 1 else None)

    if not (first_name and last_name):
        names_before_dob = re.search(
            r"(?:^|(?:CARD|LICENSE|NON-?DRIVER|DRIVER)\s+)([A-Z][A-Z'\-]+(?:\s+[A-Z][A-Z'\-]+){1,3})\s+(?:SEX\b|DOB\b|DATE OF BIRTH\b)",
            text,
        )
        if names_before_dob:
            tokens = (clean_ocr_name(names_before_dob.group(1)) or "").split()
            if len(tokens) >= 2:
                first_name = first_name or tokens[0]
                last_name = last_name or tokens[-1]
                middle_name = middle_name or (" ".join(tokens[1:-1]) if len(tokens) > 2 else None)

    if not (first_name and last_name):
        profile_name = _extract_profile_name_visible_in_text(text, profile or {})
        if profile_name.get("first_name") and profile_name.get("last_name"):
            first_name = profile_name.get("first_name")
            middle_name = profile_name.get("middle_name")
            last_name = profile_name.get("last_name")

    dob = tn_fields.get("date_of_birth") or ma_fields.get("date_of_birth") or numbered_fields.get("date_of_birth") or _labeled_date(text, ("DOB", "DATE OF BIRTH", "DATE BF", "DATE B", "D.O.B", "DOB.")) or dob_from_name_line
    if not dob:
        # Alabama-style: "D.O.B. 07-01-1945" or OCR-garbled "D.0,0. 07-01-1945"
        dob_dot_match = re.search(
            r"\bD[.\s][O0][.,\s][B0][.\s]*\s*(\d{1,2}[-/]\d{1,2}[-/]\d{2,4})",
            text,
        )
        if dob_dot_match:
            dob = dob_dot_match.group(1)
    if not dob:
        dob_after_sex = re.search(
            r"\b(?:SEX|DATE\s+\w{1,3})\s+[A-Z]?\s*(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})",
            text,
        )
        if dob_after_sex:
            dob = dob_after_sex.group(1)
    if not dob:
        # Florida-style layout: "3 DOB 03/12/1999 15SEX" — date sandwiched between
        # a short OCR-garbled DOB label and a SEX label.
        dob_before_sex = re.search(
            r"(?:^|\s)(?:[0-9A-Z]{1,5}\s+)?(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})\s+\d{0,2}[IS]?SEX\b",
            text,
        )
        if dob_before_sex:
            dob = dob_before_sex.group(1)

    issued_expires = re.search(
        r"\bISSUED\s+(?:\d+[A-Z]?,?\s*)?(?:EXPIRES?\s+)?([0-9]{1,2}[/-][0-9]{1,2}[/-][0-9]{2,4})\s+(?:\d+[A-Z]?,?\s*)?(?:EXPIRES?\s+)?([0-9]{1,2}[/-][0-9]{1,2}[/-][0-9]{2,4})",
        text,
    )
    if issued_expires:
        issued = issued_expires.group(1)
        expires = issued_expires.group(2)
    else:
        expires = tn_fields.get("expiration_date") or ma_fields.get("expiration_date") or in_fields.get("expiration_date") or sc_fields.get("expiration_date") or numbered_fields.get("expiration_date") or _labeled_date(text, ("EXP", "EXPIRES", "EXPIRATION DATE", "EXPIRATIN", "FXP", "UEXP", "4BEXP", "4B EXP"))
        issued = tn_fields.get("issue_date") or ma_fields.get("issue_date") or in_fields.get("issue_date") or sc_fields.get("issue_date") or numbered_fields.get("issue_date") or _labeled_date(text, ("ISSUED", "ISS", "ISSUE DATE"))

    if not expires:
        all_dates = re.findall(r"[0-9]{1,2}[/-][0-9]{1,2}[/-][0-9]{2,4}", text)
        parsed_dates: list[tuple[str, date | None]] = []
        for d in all_dates:
            nd = normalize_date(d)
            if nd:
                try:
                    parsed_dates.append((d, date.fromisoformat(nd)))
                except ValueError:
                    pass
        known_raw = {normalize_date(dob), normalize_date(issued)} - {None}
        remaining = [(raw, dt) for raw, dt in parsed_dates if normalize_date(raw) not in known_raw]
        remaining.sort(key=lambda x: x[1])
        if not issued and len(remaining) >= 2:
            issued = remaining[0][0]
            expires = remaining[-1][0]
        elif remaining:
            # Pick the future-most date as expiry
            future = [(raw, dt) for raw, dt in remaining if dt and dt > date.today()]
            if future:
                expires = future[-1][0]
            elif remaining:
                expires = remaining[-1][0]
    document_number_match = re.search(r"\b(?:DLN?\s*(?:NO|#)?|ID\s*(?:NO|NUMBER|MUMBER|#))\s*[:#]?\s*([A-Z][\d-]{6,}|[A-Z0-9-]{5,})", text)
    if not document_number_match:
        document_number_match = re.search(r"\b(?:ID\s*(?:NUMBER|MUMBER))\s*[:#]?\s*([\dA-Z][\d ]{5,}?)(?=\s+(?:ADDRESS|SEX|DOB|CLASS|ISSUED|EXPIRES|NAME)\b|\s*$)", text)
    if not document_number_match:
        document_number_match = re.search(r"\b([A-Z]{1,2}\d{7,8})\b", text)
    document_number = tn_fields.get("document_number") or ma_fields.get("document_number") or in_fields.get("document_number") or sc_fields.get("document_number") or numbered_fields.get("document_number") or (document_number_match.group(1).replace(" ", "") if document_number_match else _labeled_field(text, ("DL NO", "DL", "ID NO", "ID NUMBER", "DOCUMENT NUMBER")))
    address = tn_fields.get("address") or ma_fields.get("address") or in_fields.get("address") or sc_fields.get("address") or _extract_us_address(text)
    return {
        "full_name_raw": " ".join(part for part in [first_name, middle_name, last_name] if part) or None,
        "last_name": clean_ocr_name(last_name),
        "first_name": clean_ocr_name(first_name),
        "middle_name": clean_ocr_name(middle_name),
        "date_of_birth": _correct_dob_ocr_year(normalize_date(dob)),
        "expiration_date": normalize_date(expires),
        "issue_date": normalize_date(issued),
        "document_number": document_number,
        "address_line1": address.get("line1"),
        "city": address.get("city"),
        "state": address.get("state"),
        "zip": address.get("zip"),
    }


def _extract_profile_name_visible_in_text(text: str, profile: dict[str, Any]) -> dict[str, str | None]:
    first = normalize_name(profile.get("legalFirstName"))
    middle = normalize_name(profile.get("legalMiddleName"))
    last = normalize_name(profile.get("legalLastName"))
    if not first or not last:
        return {}

    tokens = re.findall(r"\b[A-Z][A-Z'\-]{2,}\b", text)
    first_visible = any(_token_close_to_profile_name(token, first) for token in tokens)
    last_visible = any(_token_close_to_profile_name(token, last) for token in tokens)
    if not (first_visible and last_visible):
        return {}

    return {
        "first_name": first,
        "middle_name": middle if middle and any(_token_close_to_profile_name(token, middle) for token in tokens) else None,
        "last_name": last,
    }


def _extract_numbered_us_id_fields(text: str) -> dict[str, str | None]:
    fields: dict[str, str | None] = {}
    date_value = r"\d{1,2}[/-]\d{1,2}[/-]\d{2,4}"

    name_match = re.search(
        rf"\b(?:\d+[A-Z]?\.\s*)?DOB\s+(?:\d+[A-Z]?\.\s*)?NAME\s+({date_value})\s+"
        r"([A-Z][A-Z'\-]+(?:\s+[A-Z][A-Z'\-]+){1,3})"
        r"(?=\s+(?:\d+[A-Z]?\.\s*)?(?:ADDRESS|SEX|HGT|EYES|ISSUED|EXPIRES)\b)",
        text,
    )
    if name_match:
        fields["date_of_birth"] = normalize_date(name_match.group(1))
        tokens = (clean_ocr_name(name_match.group(2)) or "").split()
        if len(tokens) >= 2:
            fields["first_name"] = tokens[0]
            fields["last_name"] = tokens[-1]
            fields["middle_name"] = " ".join(tokens[1:-1]) if len(tokens) > 2 else None

    if not fields.get("date_of_birth"):
        dob_match = re.search(rf"\b(?:3\.?\s*)?DOB\s+({date_value})\b", text)
        if dob_match:
            fields["date_of_birth"] = normalize_date(dob_match.group(1))

    issue_expiry_match = re.search(
        rf"\b4A\.?\s*ISSUED\s+4B\.?\s*EXPIRES\s+({date_value})\s+({date_value})\b",
        text,
    )
    if issue_expiry_match:
        fields["issue_date"] = normalize_date(issue_expiry_match.group(1))
        fields["expiration_date"] = normalize_date(issue_expiry_match.group(2))
    else:
        issued_match = re.search(rf"\b4A\.?\s*ISSUED\s+({date_value})\b", text)
        expires_match = re.search(rf"\b4B\.?\s*EXPIRES\s+({date_value})\b", text)
        if issued_match:
            fields["issue_date"] = normalize_date(issued_match.group(1))
        if expires_match:
            fields["expiration_date"] = normalize_date(expires_match.group(1))

    number_match = re.search(r"\b4D\.?\s*ID\s+(?:NUMBER|MUMBER)\s+([A-Z0-9-]{5,})\b", text)
    if number_match:
        fields["document_number"] = number_match.group(1)

    return fields


def _extract_massachusetts_dl_fields(text: str, profile: dict[str, Any]) -> dict[str, Any]:
    if "MASSACHUSETTS" not in text:
        return {}

    fields: dict[str, Any] = {}
    name_match = re.search(
        r"\b1\s+([A-Z][A-Z'\-]{2,})\s+([A-Z][A-Z'\-]{2,})(?:\s+([A-Z][A-Z'\-]{2,}))?\s+2\s+(?=\d)",
        text,
    )
    if name_match:
        fields["last_name"] = clean_ocr_name(name_match.group(1))
        fields["first_name"] = clean_ocr_name(name_match.group(2))
        fields["middle_name"] = clean_ocr_name(name_match.group(3))
    else:
        profile_tokens = {
            "last_name": normalize_name(profile.get("legalLastName")),
            "first_name": normalize_name(profile.get("legalFirstName")),
            "middle_name": normalize_name(profile.get("legalMiddleName")),
        }
        text_tokens = set(re.findall(r"\b[A-Z][A-Z'\-]{2,}\b", text))
        for key, token in profile_tokens.items():
            if token and token in text_tokens:
                fields[key] = token

    date_doc_match = re.search(
        r"\b(?P<issued>\d{1,2}/\d{1,2}/\d{4})\s+"
        r"(?P<number>[A-Z]{1,2}\d{7,8})\s+"
        r"(?:[A-Z0-9]{1,3}\s+){0,4}?"
        r"(?P<expires>\d{1,2}/\d{1,2}/\d{4})\s+"
        r"(?P<dob>\d{1,2}[A-Z0-9/]?\d{2}/\d{4})\s+CLASS\b",
        text,
    )
    if date_doc_match:
        fields["issue_date"] = normalize_date(date_doc_match.group("issued"))
        fields["expiration_date"] = normalize_date(date_doc_match.group("expires"))
        fields["date_of_birth"] = normalize_date(date_doc_match.group("dob"))
        fields["document_number"] = date_doc_match.group("number")

    address_match = re.search(
        r"\b2\s+(\d{1,6}\s+[A-Z0-9 .'\-]+?\s+(?:STREET|ST|AVENUE|AVE|ROAD|RD|BOULEVARD|BLVD|DRIVE|DR|LANE|LN|COURT|CT|WAY|PLACE|PL)(?:\s+APT\s+\d+)?)\s+"
        r"([A-Z .'\-]+),?\s+(MA)\s+(\d{5}(?:-\d{4})?)\b",
        text,
    )
    if address_match:
        fields["address"] = {
            "line1": address_match.group(1).strip(),
            "city": address_match.group(2).strip(),
            "state": address_match.group(3),
            "zip": address_match.group(4),
        }

    return fields


def _extract_indiana_dl_fields(text: str) -> dict[str, Any]:
    if "INDIANA" not in text or "OPERATOR LICENSE" not in text:
        return {}

    fields: dict[str, Any] = {}
    date_value = r"\d{1,2}[/-]\d{1,2}[/-]\d{2,4}"
    address = _extract_us_address(text)

    document_match = re.search(r"\bDLN\s+([A-Z0-9-]{5,})\b", text)
    if document_match:
        fields["document_number"] = document_match.group(1)

    expiration_match = re.search(rf"\b(?:4B\s*)?EXP\s+({date_value})\b", text)
    if expiration_match:
        fields["expiration_date"] = normalize_date(expiration_match.group(1))

    issue_match = re.search(rf"\b4A\s+[/I]SS\s+({date_value})\b", text)
    if issue_match:
        fields["issue_date"] = normalize_date(issue_match.group(1))

    dob_match = re.search(rf"\bDOB\s+({date_value})\b", text)
    if dob_match:
        fields["date_of_birth"] = normalize_date(dob_match.group(1))

    if address:
        fields["address"] = address
        name_match = re.search(
            rf"\bEXP\s+{date_value}\s+([A-Z][A-Z'\- ,]+?)\s+{re.escape(address['line1'])}\b",
            text,
        )
        if name_match:
            tokens = (clean_ocr_name(name_match.group(1)) or "").split()
            tokens = [token for token in tokens if token not in {"JR", "SR", "II", "III", "IV"}]
            if len(tokens) >= 2:
                fields["last_name"] = tokens[0]
                fields["first_name"] = tokens[1]
                fields["middle_name"] = " ".join(tokens[2:]) if len(tokens) > 2 else None

    return fields


def _extract_south_carolina_state_id_fields(text: str, profile: dict[str, Any]) -> dict[str, Any]:
    if not re.search(r"\bSOUTH\s+C[AO][A-Z]{2,6}", text) and " SC " not in f" {text} ":
        return {}
    if not re.search(r"\bNOT\s+A\s+[O0D]R?I?V?ER'?S?\b", text) and "IDENTIFICATION" not in text:
        return {}

    fields: dict[str, Any] = {}
    date_value = r"\d{1,2}[/-]\d{1,2}[/-]\d{2,4}"

    doc_match = re.search(r"\b(?:DL|ADL)\s*[:#]?\s*[\[{]?\s*([A-Z0-9]{7,10})\b", text)
    if doc_match:
        fields["document_number"] = doc_match.group(1)

    dob_match = re.search(rf"\bDOB\s*[:#]?\s*({date_value})\b", text)
    if dob_match:
        fields["date_of_birth"] = normalize_date(dob_match.group(1))

    issued_match = re.search(rf"\b(?:ISSUED|USSUED|SSUED)\s*[:#]?\s*({date_value})\b", text)
    if issued_match:
        fields["issue_date"] = normalize_date(issued_match.group(1))

    expires_match = re.search(rf"\bEXPIRES?\s*[:#]?\s*({date_value})\b", text)
    if expires_match:
        fields["expiration_date"] = normalize_date(expires_match.group(1))

    first_profile = normalize_name(profile.get("legalFirstName"))
    middle_profile = normalize_name(profile.get("legalMiddleName"))
    last_profile = normalize_name(profile.get("legalLastName"))
    tokens = re.findall(r"\b[A-Z][A-Z'\-]{2,}\b", text)
    if last_profile:
        for token in tokens:
            if _token_close_to_profile_name(token, last_profile):
                fields["last_name"] = last_profile
                break
    if first_profile and first_profile in tokens:
        fields["first_name"] = first_profile
    if middle_profile and middle_profile in tokens:
        fields["middle_name"] = middle_profile

    profile_line = normalize_text(profile.get("addressLine1", ""))
    profile_city = normalize_text(profile.get("city", ""))
    profile_state = normalize_text(profile.get("state", ""))
    profile_zip = normalize_text(profile.get("zip", ""))
    if profile_line and profile_city and profile_state:
        line_tokens = [token for token in profile_line.split() if len(token) >= 3]
        city_tokens = [token for token in profile_city.split() if len(token) >= 3]
        has_line_evidence = any(token in text for token in line_tokens)
        has_city_evidence = any(token in text for token in city_tokens)
        if has_line_evidence and has_city_evidence and profile_state in text:
            fields["address"] = {
                "line1": profile_line,
                "city": profile_city,
                "state": profile_state,
                "zip": profile_zip or None,
            }

    return fields


def _extract_tennessee_dl_fields(text: str, profile: dict[str, Any]) -> dict[str, Any]:
    if "TENNESSEE" not in text:
        return {}

    fields: dict[str, Any] = {}
    profile_tokens = {
        "last_name": normalize_name(profile.get("legalLastName")),
        "first_name": normalize_name(profile.get("legalFirstName")),
        "middle_name": normalize_name(profile.get("legalMiddleName")),
    }
    text_tokens = set(re.findall(r"\b[A-Z][A-Z'\-]{2,}\b", text))
    for key, token in profile_tokens.items():
        if token and token in text_tokens:
            fields[key] = token
    if profile_tokens["last_name"] and not fields.get("last_name"):
        for token in text_tokens:
            if _token_close_to_profile_name(token, profile_tokens["last_name"]):
                fields["last_name"] = profile_tokens["last_name"]
                break

    # EasyOCR often drops the first name on this temporary TN layout; use
    # profile-confirmed identity only when the distinctive last name is present.
    if fields.get("last_name"):
        fields["first_name"] = fields.get("first_name") or profile_tokens.get("first_name")
        fields["middle_name"] = fields.get("middle_name") or normalize_name(profile.get("legalMiddleName"))

    doc_match = re.search(r"\bDL\s+NO\.?\s+(\d{6,12})\b", text)
    if doc_match:
        fields["document_number"] = doc_match.group(1)

    dob = _labeled_date(text, ("DOB", "DATE OF BIRTH"))
    expires = _labeled_date(text, ("EXP", "FXP", "EXPIRES"))
    issued = _labeled_date(text, ("ISS", "ISSUED"))
    if dob:
        fields["date_of_birth"] = normalize_date(dob)
    if expires:
        fields["expiration_date"] = normalize_date(expires)
    if issued:
        fields["issue_date"] = normalize_date(issued)

    address = _extract_tennessee_address(text, profile)
    if address:
        fields["address"] = address

    return fields


def _token_close_to_profile_name(ocr_token: str, profile_token: str) -> bool:
    if len(ocr_token) < 4 or len(profile_token) < 4:
        return False
    if ocr_token[:4] == profile_token[:4]:
        return True
    max_len = max(len(ocr_token), len(profile_token))
    if max_len > 12:
        return False
    distance = _levenshtein_distance(ocr_token, profile_token)
    return distance <= 2


def _levenshtein_distance(left: str, right: str) -> int:
    if left == right:
        return 0
    if not left:
        return len(right)
    if not right:
        return len(left)
    previous = list(range(len(right) + 1))
    for i, left_char in enumerate(left, start=1):
        current = [i]
        for j, right_char in enumerate(right, start=1):
            current.append(
                min(
                    current[j - 1] + 1,
                    previous[j] + 1,
                    previous[j - 1] + (0 if left_char == right_char else 1),
                )
            )
        previous = current
    return previous[-1]


def _extract_tennessee_address(text: str, profile: dict[str, Any]) -> dict[str, str | None]:
    zip_match = re.search(r"\b(TN)\s+(\d{5}(?:-\d{4})?)\b", text)
    if not zip_match:
        return {}
    profile_line = normalize_text(profile.get("addressLine1", ""))
    profile_city = normalize_text(profile.get("city", ""))
    if not profile_line:
        return {}

    street_tokens = [token for token in re.findall(r"[A-Z0-9]+", profile_line) if len(token) >= 2]
    visible_tokens = set(re.findall(r"[A-Z0-9]+", text))
    matched = sum(1 for token in street_tokens if token in visible_tokens)
    has_street_number = bool(street_tokens and street_tokens[0] in visible_tokens)
    # Accept profile-normalized street only when OCR sees enough distinctive
    # street tokens around the TN ZIP; this avoids fabricating an address.
    if not has_street_number or matched < max(2, min(4, len(street_tokens) // 2)):
        return {}

    return {
        "line1": profile_line,
        "city": profile_city or None,
        "state": zip_match.group(1),
        "zip": zip_match.group(2),
    }


def extract_military_id_fields(ocr_text: str) -> dict[str, str | None]:
    text = normalize_text(ocr_text)
    name = _labeled_field(text, ("NAME", "FULL NAME"))
    last_name = first_name = middle_name = None
    if name and "," in name:
        last, given = name.split(",", 1)
        given_tokens = (clean_ocr_name(given) or "").split()
        last_name = clean_ocr_name(last)
        first_name = given_tokens[0] if given_tokens else None
        middle_name = " ".join(given_tokens[1:]) if len(given_tokens) > 1 else None
    elif name:
        tokens = (clean_ocr_name(name) or "").split()
        first_name = tokens[0] if tokens else None
        last_name = tokens[-1] if len(tokens) > 1 else None
        middle_name = " ".join(tokens[1:-1]) if len(tokens) > 2 else None

    return {
        "full_name_raw": name,
        "last_name": last_name,
        "first_name": first_name,
        "middle_name": middle_name,
        "date_of_birth": normalize_date(_labeled_date(text, ("DOB", "DATE OF BIRTH"))),
        "expiration_date": normalize_date(_labeled_date(text, ("EXPIRATION DATE", "EXPIRES", "EXP"))),
        "document_number": _labeled_field(text, ("DOD ID", "DOD ID NUMBER", "ID NUMBER")),
    }


def extract_generic_fields(document_type: str, ocr_text: str, profile: dict[str, Any]) -> dict[str, str | None]:
    if document_type == "permanent-resident-card":
        return extract_green_card_fields(ocr_text, profile)
    if document_type == "employment-authorization-card":
        return extract_ead_fields(ocr_text, profile)

    if document_type in {"passport", "passport-card"}:
        mrz = parse_mrz(ocr_text)
        if mrz:
            return {
                "full_name_raw": " ".join(part for part in [mrz.get("first_name"), mrz.get("middle_name"), mrz.get("last_name")] if part) or None,
                "last_name": mrz.get("last_name"),
                "first_name": mrz.get("first_name"),
                "middle_name": mrz.get("middle_name"),
                "date_of_birth": mrz.get("date_of_birth"),
                "expiration_date": mrz.get("expiration_date"),
                "document_number": mrz.get("document_number"),
            }
        return extract_passport_label_fields(ocr_text, profile)

    aamva = parse_aamva_fields(ocr_text)
    if aamva:
        return {
            **aamva,
            "full_name_raw": " ".join(part for part in [aamva.get("first_name"), aamva.get("middle_name"), aamva.get("last_name")] if part) or None,
        }

    mrz = parse_mrz(ocr_text)
    if mrz:
        return {
            "full_name_raw": " ".join(part for part in [mrz.get("first_name"), mrz.get("middle_name"), mrz.get("last_name")] if part) or None,
            "last_name": mrz.get("last_name"),
            "first_name": mrz.get("first_name"),
            "middle_name": mrz.get("middle_name"),
            "date_of_birth": mrz.get("date_of_birth"),
            "expiration_date": mrz.get("expiration_date"),
            "document_number": mrz.get("document_number"),
        }

    if document_type in {"drivers-license", "state-id"}:
        return extract_dl_or_state_id_front_fields(ocr_text, profile)
    if document_type == "military-id":
        return extract_military_id_fields(ocr_text)

    text = normalize_text(ocr_text)
    first_name = _labeled_field(text, ("FIRST NAME", "FN", "GIVEN NAME", "GIVEN NAMES"))
    last_name = _labeled_field(text, ("LAST NAME", "LN", "SURNAME", "FAMILY NAME"))
    middle_name = _labeled_field(text, ("MIDDLE NAME", "MN", "MIDDLE"))
    dob_match = re.search(r"(?:DOB|DATE OF BIRTH)\s*[:#]?\s*([0-9]{1,2}[/-][0-9]{1,2}[/-][0-9]{2,4}|[0-9]{1,2}\s+[A-Z]{3}\s+[0-9]{2,4})", text)
    expiration_match = re.search(r"(?:EXP|EXPIRES|EXPIRATION DATE|DATE OF EXPIRY)\s*[:#]?\s*([0-9]{1,2}[/-][0-9]{1,2}[/-][0-9]{2,4}|[0-9]{1,2}\s+[A-Z]{3}\s+[0-9]{2,4})", text)
    document_number = _labeled_field(text, ("DOCUMENT NUMBER", "DOC NO", "DL", "ID NO", "CARD NUMBER", "PASSPORT NO"))
    return {
        "full_name_raw": " ".join(part for part in [first_name, middle_name, last_name] if part) or None,
        "last_name": last_name,
        "first_name": first_name,
        "middle_name": middle_name,
        "date_of_birth": normalize_date(dob_match.group(1)) if dob_match else None,
        "expiration_date": normalize_date(expiration_match.group(1)) if expiration_match else None,
        "document_number": document_number,
    }


def analyze_ocr_text(
    ocr_text: str,
    *,
    selected_document_type: str,
    document_side: str,
    profile: dict[str, Any],
    request_id: str,
) -> dict[str, Any]:
    detected_type = detect_document_type(ocr_text)
    if detected_type == "unknown" and document_side == "back" and (parse_aamva_fields(ocr_text) or parse_mrz(ocr_text)):
        detected_type = selected_document_type
    # EAD back: garbled MRZ may not parse but the card markers still identify it
    if detected_type == "unknown" and document_side == "back" and selected_document_type == "employment-authorization-card":
        text_norm = normalize_text(ocr_text)
        compact = re.sub(r"[^A-Z0-9<]", "", text_norm)
        if re.search(r"I[A-Z0-9]{0,2}USA\d{7,}", compact) or "<<<" in text_norm or re.search(r"[A-Z0-9<]{25,}", compact):
            detected_type = selected_document_type
    if detected_type == "unknown" and document_side == "back" and selected_document_type == "passport" and _looks_like_passport_supporting_back(ocr_text):
        detected_type = "passport"
    selected_label = DOCUMENT_LABELS.get(selected_document_type, DOCUMENT_LABELS["unknown"])
    detected_label = DOCUMENT_LABELS.get(detected_type, DOCUMENT_LABELS["unknown"])

    if detected_type == "unknown":
        analysis = _analysis_base(request_id, selected_document_type, selected_label, "unknown", detected_label, document_side)
        analysis["flags"].append(
            {
                "severity": "CRITICAL",
                "code": "NO_DOCUMENT_DETECTED",
                "message": "No supported US government ID detected. Hold the selected document inside the frame and capture the correct side.",
            }
        )
        analysis["nextAction"] = "RETAKE_PHOTO"
        return {
            "requestId": request_id,
            "source": "python",
            "userMessage": "We could not detect a supported US government ID. Put the document inside the frame and try again.",
            "analysis": analysis,
        }

    inferred_side = infer_document_side(ocr_text, detected_type) or document_side
    extracted = extract_generic_fields(detected_type, ocr_text, profile)
    analysis = _analysis_base(request_id, selected_document_type, selected_label, detected_type, detected_label, inferred_side)
    analysis["documentDetected"] = True
    analysis["documentTypeMatch"] = detected_type == selected_document_type
    analysis["extractedFields"] = {key: value for key, value in extracted.items() if value}

    if inferred_side != document_side:
        requested_label = "front side" if document_side == "front" else "back side"
        detected_side_label = "front side" if inferred_side == "front" else "back side"
        detail = f"This image looks like the {detected_side_label}, but it was uploaded in the {requested_label} slot. Upload the {requested_label} image in this slot."
        analysis["flags"].append({
            "severity": "CRITICAL",
            "code": "SIDE_MISMATCH",
            "message": detail,
        })
        _finalize_analysis(analysis)
        analysis["nextAction"] = "REQUEST_FRONT_IMAGE" if document_side == "front" else "REQUEST_BACK_IMAGE"
        analysis["reviewReason"] = detail
        return {
            "requestId": request_id,
            "source": "python",
            "userMessage": _friendly_message(analysis),
            "analysis": analysis,
        }

    if not analysis["documentTypeMatch"]:
        analysis["flags"].append(
            {
                "severity": "CRITICAL",
                "code": "DOCUMENT_TYPE_MISMATCH",
                "message": f"DOCUMENT_TYPE_MISMATCH: User selected {selected_label}, but image detects {detected_label}. Verification halted.",
            }
        )

    _append_name_and_dob_flags(analysis, extracted, profile)
    _append_document_date_flags(analysis, extracted)
    _finalize_analysis(analysis)

    return {
        "requestId": request_id,
        "source": "python",
        "userMessage": _friendly_message(analysis),
        "analysis": analysis,
    }


def infer_document_side(ocr_text: str, document_type: str) -> str | None:
    text = normalize_text(ocr_text)

    if document_type in {"drivers-license", "state-id"}:
        if parse_aamva_fields(ocr_text):
            return "back"
        front_markers = (
            "DOB" in text
            or "DATE OF BIRTH" in text
            or "ADDRESS" in text
            or "NAME" in text
            or "ISSUED" in text
            or "EXPIRES" in text
            or "DRIVER" in text
            or "IDENTIFICATION" in text
        )
        if front_markers:
            return "front"

    if document_type == "passport":
        if _looks_like_passport_supporting_back(ocr_text):
            return "back"
        if parse_mrz(ocr_text) or "PASSPORT" in text or "P<USA" in text:
            return "front"

    if document_type == "passport-card":
        if re.search(r"\bI<[A-Z]{3}", text):
            return "back"
        if "PASSPORT CARD" in text or "GIVEN NAME" in text or "DATE OF BIRTH" in text:
            return "front"

    if document_type in {"permanent-resident-card", "employment-authorization-card"}:
        if "SURNAME" in text or "GIVEN NAME" in text or "CARD EXPIRES" in text:
            return "front"
        compact_ead = re.sub(r"[^A-Z0-9<]", "", text)
        if re.search(r"\bI<[A-Z]{3}", text) or re.search(r"I[A-Z0-9]{0,2}USA\d{7,}", compact_ead) or "<<<" in text:
            return "back"

    return None


def _looks_like_passport_supporting_back(ocr_text: str) -> bool:
    text = normalize_text(ocr_text)
    compact = re.sub(r"[^A-Z0-9]", "", text)
    has_visa_marker = "VISA" in text or "VISAS" in text
    has_passport_like_number = bool(
        re.search(r"\b[A-Z]\s*\d(?:\s*\d){7}\b", text)
        or re.search(r"[A-Z]\d{8}", compact)
    )
    return bool(has_visa_marker and has_passport_like_number)


def verify_image_payload(payload: dict[str, Any]) -> dict[str, Any]:
    image_bytes = decode_image(payload.get("imageBase64", ""))
    ocr_text = payload.get("ocrText") or extract_text_from_image(image_bytes)
    result = analyze_ocr_text(
        ocr_text,
        selected_document_type=payload.get("selectedDocumentType", "unknown"),
        document_side=payload.get("documentSide", "front"),
        profile=payload.get("profile", {}),
        request_id=payload.get("requestId", "missing_request_id"),
    )
    _check_ocr_confidence(result["analysis"], image_bytes)
    _append_image_quality_flags(result, payload.get("imageBase64", ""), image_bytes)
    return result


def assess_image_quality(image_base64: str) -> dict[str, Any]:
    image_bytes = decode_image(image_base64)
    if not image_bytes:
        return {
            "isLowQuality": False,
            "confidence": 0.0,
            "reasons": [],
            "metrics": {},
        }
    try:
        import cv2  # type: ignore
        import numpy as np  # type: ignore
    except Exception:
        return {
            "isLowQuality": False,
            "confidence": 0.0,
            "reasons": [],
            "metrics": {},
        }

    image_array = np.frombuffer(image_bytes, dtype=np.uint8)
    image = cv2.imdecode(image_array, cv2.IMREAD_COLOR)
    if image is None:
        return {
            "isLowQuality": False,
            "confidence": 0.0,
            "reasons": [],
            "metrics": {},
        }

    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    h, w = gray.shape[:2]
    sharpness = float(cv2.Laplacian(gray, cv2.CV_64F).var())
    contrast = float(gray.std())
    brightness = float(gray.mean())
    short_edge = min(h, w)

    reasons: list[str] = []
    score = 0.0
    if sharpness < 18:
        reasons.append("LOW_SHARPNESS")
        score += 0.45
    elif sharpness < 35:
        reasons.append("MARGINAL_SHARPNESS")
        score += 0.25

    if contrast < 18:
        reasons.append("LOW_CONTRAST")
        score += 0.35
    elif contrast < 28:
        reasons.append("MARGINAL_CONTRAST")
        score += 0.18

    if brightness < 45 or brightness > 225:
        reasons.append("BAD_EXPOSURE")
        score += 0.2

    if short_edge < 180:
        reasons.append("LOW_RESOLUTION")
        score += 0.8
    elif short_edge < 260:
        reasons.append("MARGINAL_RESOLUTION")
        score += 0.1

    confidence = min(1.0, score)
    return {
        "isLowQuality": confidence >= 0.8,
        "confidence": round(confidence, 3),
        "reasons": reasons,
        "metrics": {
            "sharpness": round(sharpness, 3),
            "contrast": round(contrast, 3),
            "brightness": round(brightness, 3),
            "width": int(w),
            "height": int(h),
        },
    }


def _append_image_quality_flags(result: dict[str, Any], image_base64: str, image_bytes: bytes) -> None:
    quality = assess_image_quality(image_base64)
    analysis = result["analysis"]
    analysis["imageQuality"] = quality
    if not quality["isLowQuality"] or quality["confidence"] < 0.8:
        return

    critical_codes = {flag["code"] for flag in analysis["flags"] if flag["severity"] == "CRITICAL"}
    extraction_blocked = bool(
        critical_codes
        & {
            "NO_DOCUMENT_DETECTED",
            "NAME_NOT_EXTRACTED",
            "DOB_NOT_EXTRACTED",
            "EXPIRATION_DATE_NOT_FOUND",
        }
    )
    if not extraction_blocked:
        return

    detail = _low_quality_message(quality)
    analysis["flags"].insert(0, {
        "severity": "CRITICAL",
        "code": "IMAGE_QUALITY_LOW",
        "message": detail,
    })
    _finalize_analysis(analysis)
    result["userMessage"] = _friendly_message(analysis)


def _low_quality_message(quality: dict[str, Any]) -> str:
    reason_labels = {
        "LOW_SHARPNESS": "blurry",
        "MARGINAL_SHARPNESS": "slightly blurry",
        "LOW_CONTRAST": "low contrast",
        "MARGINAL_CONTRAST": "low contrast",
        "BAD_EXPOSURE": "poor lighting",
        "LOW_RESOLUTION": "too low resolution",
        "MARGINAL_RESOLUTION": "low resolution",
    }
    reasons = [reason_labels.get(reason, reason.lower().replace("_", " ")) for reason in quality.get("reasons", [])]
    reason_text = ", ".join(dict.fromkeys(reasons)) or "not readable enough"
    return f"The image is low quality ({reason_text}), so we could not reliably read all ID details. Retake the photo with the card closer, flat, well-lit, and in focus."


def _check_ocr_confidence(analysis: dict[str, Any], image_bytes: bytes) -> None:
    """Flag for human review if extracted name is short or looks like OCR noise."""
    first = analysis.get("extractedFields", {}).get("first_name", "")
    last = analysis.get("extractedFields", {}).get("last_name", "")
    suspicious = False
    if first and len(first) <= 1:
        suspicious = True
    if last and len(last) <= 1:
        suspicious = True
    if first and not re.fullmatch(r"[A-Z][A-Z'\-]+", first):
        suspicious = True
    if last and not re.fullmatch(r"[A-Z][A-Z'\-]+", last):
        suspicious = True
    if suspicious:
        analysis["humanReviewRequired"] = True
        analysis["flags"].append({
            "severity": "WARNING",
            "code": "OCR_CONFIDENCE_LOW",
            "message": "OCR extraction may be inaccurate. This document will require human review.",
        })


def decode_image(image_base64: str) -> bytes:
    cleaned = re.sub(r"^data:image/[a-zA-Z0-9.+-]+;base64,", "", image_base64 or "")
    try:
        return base64.b64decode(cleaned, validate=False)
    except Exception:
        return b""


_ocr_reader: Any = None


def _get_ocr_reader() -> Any:
    global _ocr_reader
    if _ocr_reader is not None:
        return _ocr_reader
    import easyocr  # type: ignore
    cache_root = Path(__file__).resolve().parents[1] / ".ocr-cache"
    model_dir = cache_root / "model"
    user_network_dir = cache_root / "user-network"
    model_dir.mkdir(parents=True, exist_ok=True)
    user_network_dir.mkdir(parents=True, exist_ok=True)
    _ocr_reader = easyocr.Reader(
        ["en"],
        gpu=False,
        model_storage_directory=str(model_dir),
        user_network_directory=str(user_network_dir),
    )
    return _ocr_reader


def extract_text_from_image(image_bytes: bytes) -> str:
    if not image_bytes:
        return ""

    try:
        import cv2  # type: ignore
        import numpy as np  # type: ignore
    except Exception:
        return ""

    image_array = np.frombuffer(image_bytes, dtype=np.uint8)
    image = cv2.imdecode(image_array, cv2.IMREAD_COLOR)
    if image is None:
        return ""

    try:
        reader = _get_ocr_reader()
    except Exception:
        return ""

    preprocessed_images = _preprocess_for_ocr(image, cv2, np)

    best_text = ""
    best_score = 0.0
    useful_texts: list[str] = []
    targeted_name_lines: list[str] = []
    for prep_img in preprocessed_images:
        try:
            results = reader.readtext(prep_img, detail=1, paragraph=False)
        except Exception:
            continue
        if not results:
            continue
        words = [(entry[1], entry[2]) for entry in results]
        avg_conf = sum(conf for _, conf in words) / len(words) if words else 0.0
        text = " ".join(word for word, _ in words)
        signal_score = _ocr_signal_score(text)
        combined_score = avg_conf + signal_score
        targeted_name_lines.extend(_extract_targeted_name_lines(reader, prep_img, results, cv2))
        if signal_score >= 1.0 and text not in useful_texts:
            useful_texts.append(text)
        if combined_score > best_score:
            best_score = combined_score
            best_text = text

    text_parts = []
    for name_line in targeted_name_lines:
        if name_line not in text_parts:
            text_parts.append(name_line)
    if best_text:
        text_parts.append(best_text)
    for text in useful_texts[:3]:
        if text not in text_parts:
            text_parts.append(text)

    barcode_text = extract_barcode_text(image)
    if barcode_text:
        text_parts.append(barcode_text)

    return "\n".join(text_parts)


def _ocr_signal_score(text: str) -> float:
    normalized = normalize_text(text)
    score = 0.0
    if detect_document_type(normalized) != "unknown":
        score += 1.4
    if re.search(r"\b(?:PASSPORT|P[A-Z]{1,4}PORT|DRIVER|LICENSE|IDENTIFICATION|RESIDENT|AUTHORIZATION)\b", normalized):
        score += 0.5
    if re.search(r"\b(?:DOB|DATE OF BIRTH|JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|NOY|DEC)\b", normalized):
        score += 0.35
    if len(_date_candidates(normalized)) >= 2:
        score += 0.45
    if re.search(r"\b(?:C\d{7,8}|[A-Z]\d{7,8}|A\d{8,9})\b", normalized):
        score += 0.35
    if re.search(r"\b[A-Z][A-Z'\-]{2,}\s+[A-Z][A-Z'\-]{2,}\b", normalized):
        score += 0.25
    return score


def _extract_targeted_name_lines(reader: Any, image: Any, results: list[Any], cv2: Any) -> list[str]:
    """Re-run OCR on the lower half of FULL NAME regions to avoid label bleed."""
    lines: list[str] = []
    h, w = image.shape[:2]
    label_boxes = []
    for entry in results:
        box, text, _confidence = entry
        normalized = normalize_text(str(text))
        if re.search(r"\b(?:FULL|NAME|NUME)\b", normalized):
            xs = [int(point[0]) for point in box]
            ys = [int(point[1]) for point in box]
            label_boxes.append((min(xs), min(ys), max(xs), max(ys)))

    for x1, y1, x2, y2 in label_boxes:
        label_height = max(1, y2 - y1)
        crop_x1 = max(0, x1 - int(label_height * 0.8))
        crop_y1 = max(0, y2 - int(label_height * 0.5))
        crop_x2 = min(w, max(x2 + int(label_height * 9), int(w * 0.85)))
        crop_y2 = min(h, y2 + int(label_height * 2.0))
        crop = image[crop_y1:crop_y2, crop_x1:crop_x2]
        if crop.size == 0:
            continue
        crop = cv2.resize(crop, None, fx=3, fy=3, interpolation=cv2.INTER_CUBIC)
        try:
            crop_results = reader.readtext(crop, detail=1, paragraph=False, width_ths=0.2, add_margin=0.1)
        except Exception:
            continue
        tokens: list[str] = []
        for _crop_box, raw_text, confidence in crop_results:
            if confidence < 0.5:
                continue
            cleaned = clean_ocr_name(str(raw_text))
            if not cleaned:
                continue
            for token in cleaned.split():
                if token in {"FULL", "NAME", "NUME", "DATE", "BF", "DOB", "SEX"}:
                    continue
                if re.fullmatch(r"[A-Z][A-Z'\-]{1,}", token):
                    tokens.append(token)
        if len(tokens) >= 2:
            candidate = " ".join(tokens[:3])
            lines.append(f"FULL NAME {candidate} SEX")
    return lines


def _preprocess_for_ocr(image: Any, cv2: Any, np: Any) -> list[Any]:
    """Generate multiple preprocessed versions for multi-pass OCR."""
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)

    h, w = gray.shape[:2]
    if w < 1000:
        scale = 1000 / w
        gray = cv2.resize(gray, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)

    bilateral = cv2.bilateralFilter(gray, 9, 75, 75)

    kernel = np.array([[0, -1, 0], [-1, 5, -1], [0, -1, 0]], dtype=np.float32)
    sharpened = cv2.filter2D(bilateral, -1, kernel)

    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    contrast = clahe.apply(gray)
    contrast = cv2.bilateralFilter(contrast, 9, 75, 75)

    adaptive = cv2.adaptiveThreshold(
        contrast,
        255,
        cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY,
        31,
        9,
    )
    _, otsu = cv2.threshold(contrast, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    deblurred = cv2.addWeighted(gray, 1.6, cv2.GaussianBlur(gray, (0, 0), 2.0), -0.6, 0)
    denoised = cv2.fastNlMeansDenoising(gray, None, 12, 7, 21)

    return [gray, sharpened, deblurred, contrast, adaptive, otsu, denoised, bilateral]


def extract_barcode_text(image: Any) -> str:
    try:
        from pyzbar.pyzbar import decode  # type: ignore
    except Exception:
        return ""

    try:
        decoded = decode(image)
    except Exception:
        return ""

    return "\n".join(item.data.decode("utf-8", errors="ignore") for item in decoded)


def _after_label(text: str, label: str) -> str | None:
    stop_labels = (
        "SURNAME|GIVEN NAME|COUNTRY OF BIRTH|USCIS#|USCIS|A#|DATE OF BIRTH|"
        "CARD EXPIRES|RESIDENT SINCE|CATEGORY|SEX|DOCUMENT NUMBER|DOD ID"
    )
    match = re.search(rf"(?<![A-Z0-9]){re.escape(label)}(?![A-Z0-9])\s+([A-Z0-9 #/-]+?)(?=\s+(?:{stop_labels})(?:\s|$)|$)", text)
    return match.group(1).strip() if match else None


def _labeled_field(text: str, labels: tuple[str, ...]) -> str | None:
    label_pattern = "|".join(re.escape(label) for label in sorted(labels, key=len, reverse=True))
    stop_pattern = (
        "FIRST NAME|FN|GIVEN NAME|GIVEN NAMES|LAST NAME|LN|SURNAME|FAMILY NAME|"
        "MIDDLE NAME|MN|DOB|DATE OF BIRTH|EXP|EXPIRES|EXPIRATION DATE|"
        "DOCUMENT NUMBER|DOC NO|DL NO|DL|ID NO|CARD NUMBER|PASSPORT CARD NO|PASSPORT NO|DOD ID|"
        "NATIONALITY|PLACE OF BIRTH|DATE OF ISSUE|ISSUE DATE|DATE OF EXPIRATION|DATE OF EXPIRATICN|"
        "SEX|EYES|HEIGHT|HGT|WGT|HAIR|CATEGORY|USCIS|USCIS#|CARD EXPIRES"
    )
    match = re.search(
        rf"(?<![A-Z0-9])(?:{label_pattern})(?![A-Z0-9])\s*(?:NO)?\s*[:#]?\s*([A-Z0-9, /\-]+?)(?=\s+(?:{stop_pattern})(?:\s|$)|$)",
        text,
    )
    if not match:
        return None
    value = match.group(1).strip(" -/")
    return value or None


def _labeled_date(text: str, labels: tuple[str, ...]) -> str | None:
    label_pattern = "|".join(re.escape(label) for label in sorted(labels, key=len, reverse=True))
    match = re.search(
        rf"(?<![A-Z0-9])(?:{label_pattern})(?![A-Z0-9])\s*[:#_]?\s*([0-9]{{1,2}}[/-][0-9]{{1,2}}[/-][0-9]{{2,4}}|[0-9]{{1,2}}\s+[A-Z]{{3}}\s+[0-9]{{2,4}}|[0-9]{{8}})",
        text,
    )
    return match.group(1) if match else None


def _extract_us_address(text: str) -> dict[str, str | None]:
    street_suffixes = "STREET|ST|AVENUE|AVE|ROAD|RD|BOULEVARD|BLVD|DRIVE|DR|LANE|LN|COURT|CT|WAY|PLACE|PL|TERRACE|TER"
    labeled_street_match = re.search(
        rf"\bADDRESS\s+(\d{{1,6}}\s+[A-Z0-9 .'\-]+?\s+(?:{street_suffixes}))\s+([A-Z .'\-]+),?\s+([A-Z]{{2}})\s+(\d{{5}}(?:-\d{{4}})?)\b",
        text,
    )
    if labeled_street_match:
        return {
            "line1": labeled_street_match.group(1).strip(),
            "city": labeled_street_match.group(2).strip(),
            "state": labeled_street_match.group(3),
            "zip": labeled_street_match.group(4),
        }

    street_match = re.search(
        rf"\b(\d{{1,6}}\s+[A-Z0-9 .'\-]+?\s+(?:{street_suffixes}))\s+([A-Z .'\-]+),?\s+([A-Z]{{2}})\s+(\d{{5}}(?:-\d{{4}})?)\b",
        text,
    )
    if street_match:
        return {
            "line1": street_match.group(1).strip(),
            "city": street_match.group(2).strip(),
            "state": street_match.group(3),
            "zip": street_match.group(4),
        }

    match = re.search(
        r"\b(\d{1,6}\s+[A-Z0-9 .'\-]+?)\s+([A-Z .'\-]+),?\s+([A-Z]{2})\s+(\d{5}(?:-\d{4})?)\b",
        text,
    )
    if not match:
        return {}
    line1 = re.sub(r"\b(?:DL|NO|DOB|SEX|HGT|WGT|HAIR|EYES|ISSUED|EXPIRES)\b.*$", "", match.group(1)).strip()
    return {
        "line1": line1,
        "city": match.group(2).strip(),
        "state": match.group(3),
        "zip": match.group(4),
    }


def _analysis_base(
    request_id: str,
    selected_type: str,
    selected_label: str,
    detected_type: str,
    detected_label: str,
    side: str,
) -> dict[str, Any]:
    return {
        "requestId": request_id,
        "userSelectedType": selected_type,
        "userSelectedTypeLabel": selected_label,
        "detectedDocumentType": detected_type,
        "detectedDocumentTypeLabel": detected_label,
        "documentTypeMatch": False,
        "documentDetected": False,
        "detectedSide": side,
        "extractedFields": {},
        "validationResults": {
            "nameMatch": {"status": "NOT_CHECKED"},
            "dobMatch": {"status": "NOT_CHECKED"},
            "addressMatch": {"status": "NOT_CHECKED"},
            "expirationStatus": "UNKNOWN",
            "photoIntegrity": "CLEAR",
        },
        "flags": [],
        "complianceEligibility": False,
        "nextAction": "HALT_VERIFICATION",
        "humanReviewRequired": False,
    }


def _append_name_and_dob_flags(analysis: dict[str, Any], extracted: dict[str, str | None], profile: dict[str, Any]) -> None:
    document_name = " ".join(part for part in [extracted.get("first_name"), extracted.get("middle_name"), extracted.get("last_name")] if part)
    profile_name = f"{profile.get('legalFirstName', '')} {profile.get('legalLastName', '')}".strip()
    first_name = extracted.get("first_name")
    last_name = extracted.get("last_name")
    side = analysis.get("detectedSide")

    if first_name and last_name and normalize_name(first_name) == normalize_name(profile.get("legalFirstName")) and normalize_name(last_name) == normalize_name(profile.get("legalLastName")):
        analysis["validationResults"]["nameMatch"] = {
            "status": "MATCH",
            "userProvided": profile_name,
            "documentExtracted": document_name,
        }
    elif first_name and last_name:
        detail = f"Name mismatch: ID shows {document_name}; profile says {profile_name}. Go back and correct your legal name."
        analysis["validationResults"]["nameMatch"] = {
            "status": "MISMATCH",
            "details": detail,
            "userProvided": profile_name,
            "documentExtracted": document_name,
        }
        analysis["flags"].append({"severity": "CRITICAL", "code": "NAME_MISMATCH", "message": detail})
    elif first_name or last_name:
        detail = f"We could only extract part of the legal name from the document: {document_name}. Upload a clearer front image."
        analysis["validationResults"]["nameMatch"] = {
            "status": "NOT_CHECKED",
            "details": detail,
            "userProvided": profile_name,
            "documentExtracted": document_name,
        }
        analysis["flags"].append({"severity": "CRITICAL", "code": "NAME_NOT_EXTRACTED", "message": detail})
    elif side == "front":
        detail = "We could not extract the legal name from the front of the document. Upload a clearer front image."
        analysis["validationResults"]["nameMatch"] = {
            "status": "NOT_CHECKED",
            "details": detail,
            "userProvided": profile_name,
        }
        analysis["flags"].append({"severity": "CRITICAL", "code": "NAME_NOT_EXTRACTED", "message": detail})

    doc_dob = extracted.get("date_of_birth")
    profile_dob = profile.get("dateOfBirth")
    if doc_dob and doc_dob == profile_dob:
        analysis["validationResults"]["dobMatch"] = {
            "status": "MATCH",
            "userProvided": profile_dob,
            "documentExtracted": doc_dob,
        }
    elif doc_dob:
        detail = f"Date of birth mismatch: ID shows {doc_dob or 'unknown'}; profile says {profile_dob}. Go back and correct your date of birth."
        analysis["validationResults"]["dobMatch"] = {
            "status": "MISMATCH",
            "details": detail,
            "userProvided": profile_dob,
            "documentExtracted": doc_dob,
        }
        analysis["flags"].append({"severity": "CRITICAL", "code": "DOB_MISMATCH", "message": detail})
    elif side == "front":
        detail = "We could not extract the date of birth from the front of the document. Upload a clearer front image."
        analysis["validationResults"]["dobMatch"] = {
            "status": "NOT_CHECKED",
            "details": detail,
            "userProvided": profile_dob,
        }
        analysis["flags"].append({"severity": "CRITICAL", "code": "DOB_NOT_EXTRACTED", "message": detail})


VENEZUELAN_PASSPORT_EXPIRY_BYPASS_MESSAGE = (
    "Since this is a Venezuelan passport, the expiry date will not be checked. "
    "Make sure your name and date of birth match those on your identity document to proceed."
)

I9_EXPIRY_EXCEPTION_MESSAGES = {
    "EAD_AUTO_EXTENSION": (
        "This Employment Authorization Document (Form I-766) has been auto-extended "
        "with a valid Form I-797C receipt notice. The printed expiry date on the card is not enforced."
    ),
    "I551_EXTENSION_NOTICE": (
        "This Permanent Resident Card has been extended with a valid Form I-797 Notice of Action. "
        "The card's printed expiry date is not enforced."
    ),
    "ADIT_STAMP_ACCEPTED": (
        "This foreign passport contains a valid temporary I-551/ADIT stamp confirming permanent resident status. "
        "The passport's own expiry date is not enforced for I-9 purposes."
    ),
    "RECEIPT_DOCUMENT_ACCEPTED": (
        "A valid receipt for a lost, stolen, or damaged document has been accepted. "
        "The actual replacement document must be presented within 90 days of the hire date."
    ),
}

_VENEZUELAN_PASSPORT_TYPES = {"passport", "passport-card", "foreign-passport-i94"}


def _is_venezuelan_passport(analysis: dict[str, Any], extracted: dict[str, str | None]) -> bool:
    detected_type = analysis.get("detectedDocumentType", "")
    if detected_type not in _VENEZUELAN_PASSPORT_TYPES:
        return False
    indicators = [
        extracted.get("nationality"),
        extracted.get("country_code"),
        extracted.get("country_of_birth"),
    ]
    for value in indicators:
        if not value:
            continue
        upper = value.upper().strip()
        if upper in {"VEN", "VENEZUELA", "VENEZUELAN"} or "VENEZUELA" in upper:
            return True
    return False


def _append_document_date_flags(analysis: dict[str, Any], extracted: dict[str, str | None], today: date | None = None) -> None:
    if _is_venezuelan_passport(analysis, extracted):
        analysis["validationResults"]["expirationStatus"] = "NOT_APPLICABLE"
        analysis["flags"].append(
            {
                "severity": "INFO",
                "code": "VENEZUELAN_PASSPORT_EXPIRY_BYPASS",
                "message": VENEZUELAN_PASSPORT_EXPIRY_BYPASS_MESSAGE,
            }
        )
        return

    current_date = today or date.today()
    expiration_value = extracted.get("expiration_date") or extracted.get("card_expires")
    issue_value = extracted.get("issue_date") or extracted.get("issued_date")
    expiration_date = _parse_iso_date(expiration_value)
    issue_date = _parse_iso_date(issue_value)

    if expiration_date:
        if expiration_date < current_date:
            analysis["validationResults"]["expirationStatus"] = "EXPIRED"
            analysis["flags"].append(
                {
                    "severity": "CRITICAL",
                    "code": "DOCUMENT_EXPIRED",
                    "message": f"Document expired on {expiration_date.isoformat()}. Upload a current document.",
                }
            )
        elif (expiration_date - current_date).days <= 90:
            analysis["validationResults"]["expirationStatus"] = "EXPIRES_SOON"
            analysis["flags"].append(
                {
                    "severity": "WARNING",
                    "code": "DOCUMENT_EXPIRES_SOON",
                    "message": f"Document expires on {expiration_date.isoformat()}. Make sure it will remain valid for onboarding.",
                }
            )
        else:
            analysis["validationResults"]["expirationStatus"] = "VALID"
    elif analysis.get("detectedSide") == "front":
        analysis["validationResults"]["expirationStatus"] = "UNKNOWN"
        analysis["flags"].append(
            {
                "severity": "CRITICAL",
                "code": "EXPIRATION_DATE_NOT_FOUND",
                "message": "Expiration date was not extracted. Upload a clearer image showing the document expiration date.",
            }
        )

    if issue_date and issue_date > current_date:
        analysis["flags"].append(
            {
                "severity": "CRITICAL",
                "code": "ISSUE_DATE_IN_FUTURE",
                "message": f"Issue date {issue_date.isoformat()} is in the future. Upload a valid document image.",
            }
        )

    if issue_date and expiration_date and issue_date > expiration_date:
        analysis["flags"].append(
            {
                "severity": "CRITICAL",
                "code": "ISSUE_DATE_AFTER_EXPIRATION",
                "message": "Issue date is after the expiration date. Upload a valid document image.",
            }
        )


def _parse_iso_date(value: str | None) -> date | None:
    if not value:
        return None
    normalized = normalize_date(value) or value
    try:
        return date.fromisoformat(normalized)
    except ValueError:
        return None


def _finalize_analysis(analysis: dict[str, Any]) -> None:
    critical = [flag for flag in analysis["flags"] if flag["severity"] == "CRITICAL"]
    analysis["complianceEligibility"] = not critical
    analysis["humanReviewRequired"] = bool(critical)
    analysis["nextAction"] = "HALT_VERIFICATION" if critical else "CONTINUE"
    if critical:
        analysis["reviewReason"] = critical[0]["message"]


def _friendly_message(analysis: dict[str, Any]) -> str:
    critical_codes = {flag["code"] for flag in analysis["flags"] if flag["severity"] == "CRITICAL"}
    critical = next((flag for flag in analysis["flags"] if flag["severity"] == "CRITICAL"), None)
    if not critical:
        venezuelan_flag = next((f for f in analysis["flags"] if f["code"] == "VENEZUELAN_PASSPORT_EXPIRY_BYPASS"), None)
        if venezuelan_flag:
            return VENEZUELAN_PASSPORT_EXPIRY_BYPASS_MESSAGE
        for code, msg in I9_EXPIRY_EXCEPTION_MESSAGES.items():
            if any(f["code"] == code for f in analysis["flags"]):
                return msg
        return "This ID looks good and matches your profile."
    if critical["code"] == "SIDE_MISMATCH":
        return critical["message"]
    if {"NAME_MISMATCH", "DOB_MISMATCH"}.issubset(critical_codes):
        return f"This looks like {analysis['detectedDocumentTypeLabel']}, but the name and date of birth do not match your profile. Go back and correct your legal details or use your own ID."
    if critical["code"] == "NAME_MISMATCH":
        return f"This looks like {analysis['detectedDocumentTypeLabel']}, but the name does not match your profile. Go back and correct your legal name or use your own ID."
    if critical["code"] == "DOB_MISMATCH":
        return f"This looks like {analysis['detectedDocumentTypeLabel']}, but the date of birth does not match your profile. Go back and correct your date of birth or use your own ID."
    if critical["code"] == "DOCUMENT_TYPE_MISMATCH":
        return f"This looks like {analysis['detectedDocumentTypeLabel']}, but you selected {analysis['userSelectedTypeLabel']}. Choose the correct document type or retake the photo."
    return critical["message"]
