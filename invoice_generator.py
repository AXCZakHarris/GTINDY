"""Convert an AxisCare ClaimBatchCreation CSV into filled IRIS Provider Invoice PDFs.

Grouping rules:
- One invoice per (participant, calendar month of Visit Date).
- Multiple CSV rows on the same date for the same participant are combined into one line.
- The template has 9 service lines; if a (participant, month) group has >9 distinct service
  dates, it is split into multiple invoices (each a single printable page).
"""

from __future__ import annotations

import csv
import io
import re
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from pypdf import PdfReader, PdfWriter
from pypdf.generic import BooleanObject, NameObject, NumberObject, TextStringObject

LINES_PER_PAGE = 9
UNIT_TYPE_LABEL = "15 min"
UNITS_PER_HOUR = 4  # 15-minute units


@dataclass
class ServiceLine:
    visit_date: datetime
    procedure_code: str
    modifier: str
    hours: float
    csv_hourly_rate: float
    amount: float

    @property
    def units(self) -> int:
        # Hours come in 0.25 increments; multiply to 15-min units.
        return int(round(self.hours * UNITS_PER_HOUR))

    @property
    def unit_rate(self) -> float:
        return self.csv_hourly_rate / UNITS_PER_HOUR

    def merge(self, other: "ServiceLine") -> "ServiceLine":
        return ServiceLine(
            visit_date=self.visit_date,
            procedure_code=self.procedure_code,
            modifier=self.modifier or other.modifier,
            hours=self.hours + other.hours,
            csv_hourly_rate=self.csv_hourly_rate,
            amount=self.amount + other.amount,
        )


def _parse_money(text: str) -> float:
    if text is None:
        return 0.0
    cleaned = text.strip().replace("$", "").replace(",", "")
    if not cleaned:
        return 0.0
    return float(cleaned)


def _parse_hours(text: str) -> float:
    if not text or not text.strip():
        return 0.0
    return float(text.strip())


def _parse_date(text: str) -> datetime:
    return datetime.strptime(text.strip(), "%m/%d/%y")


def parse_csv(csv_text: str) -> dict[tuple[str, int, int], list[ServiceLine]]:
    """Return a dict keyed by (client, year, month) → list of ServiceLine (one per date)."""
    reader = csv.DictReader(io.StringIO(csv_text))

    # client → date → ServiceLine (accumulator for same-day merging)
    accum: dict[str, dict[datetime, ServiceLine]] = defaultdict(dict)

    for row in reader:
        client = (row.get("Client") or "").strip()
        if not client:
            continue
        visit_date = _parse_date(row["Visit Date"])
        hours = _parse_hours(row.get("Billable Hours", ""))
        if hours <= 0:
            continue
        rate = _parse_money(row.get("Billable Rate", ""))
        amount = _parse_money(row.get("Billable Amount", ""))
        line = ServiceLine(
            visit_date=visit_date,
            procedure_code=(row.get("Procedure Code") or "").strip(),
            modifier=(row.get("Modifiers") or "").strip(),
            hours=hours,
            csv_hourly_rate=rate,
            amount=amount,
        )
        existing = accum[client].get(visit_date)
        accum[client][visit_date] = existing.merge(line) if existing else line

    # Regroup by (client, year, month)
    grouped: dict[tuple[str, int, int], list[ServiceLine]] = defaultdict(list)
    for client, by_date in accum.items():
        for line in by_date.values():
            key = (client, line.visit_date.year, line.visit_date.month)
            grouped[key].append(line)
    for lines in grouped.values():
        lines.sort(key=lambda l: l.visit_date)
    return grouped


MEDICAID_ID_COLUMNS = (
    "Medicaid ID",
    "Medicaid Id",
    "Medicaid Number",
    "Client Medicaid ID",
    "Member ID",
    "Member Id",
    "Insurance ID",
    "Policy Number",
    "Policy #",
)

DOB_COLUMNS = (
    "DOB",
    "Date of Birth",
    "Client DOB",
    "Birth Date",
    "Birthdate",
)


@dataclass
class ClientDetails:
    """Optional per-participant identifiers, when the CSV happens to carry them."""

    medicaid_id: str = ""
    dob: datetime | None = None


def _first_column(row: dict[str, str], names: tuple[str, ...]) -> str:
    for name in names:
        value = row.get(name)
        if value and value.strip():
            return value.strip()
    return ""


def _parse_optional_date(text: str) -> datetime | None:
    for fmt in ("%m/%d/%Y", "%m/%d/%y", "%Y-%m-%d", "%m-%d-%Y"):
        try:
            return datetime.strptime(text.strip(), fmt)
        except ValueError:
            continue
    return None


def parse_client_details(csv_text: str) -> dict[str, ClientDetails]:
    """Pull participant Medicaid ID / DOB out of the CSV when those columns exist.

    AxisCare export column sets vary; every field here is best-effort and is left
    blank on the generated form when the column is absent.
    """
    reader = csv.DictReader(io.StringIO(csv_text))
    details: dict[str, ClientDetails] = {}
    for row in reader:
        client = (row.get("Client") or "").strip()
        if not client:
            continue
        current = details.setdefault(client, ClientDetails())
        if not current.medicaid_id:
            current.medicaid_id = _first_column(row, MEDICAID_ID_COLUMNS)
        if current.dob is None:
            raw_dob = _first_column(row, DOB_COLUMNS)
            if raw_dob:
                current.dob = _parse_optional_date(raw_dob)
    return details


def split_participant_name(name: str) -> tuple[str, str, str]:
    """Split an AxisCare client name into (first, middle, last).

    Handles both "Last, First M" and "First M Last" orderings.
    """
    name = " ".join(name.split())
    if not name:
        return "", "", ""
    if "," in name:
        last, _, rest = name.partition(",")
        parts = rest.split()
        first = parts[0] if parts else ""
        middle = " ".join(parts[1:])
        return first, middle, last.strip()
    parts = name.split()
    if len(parts) == 1:
        return "", "", parts[0]
    return parts[0], " ".join(parts[1:-1]), parts[-1]


def chunk_lines(lines: list[ServiceLine], size: int) -> list[list[ServiceLine]]:
    return [lines[i : i + size] for i in range(0, len(lines), size)]


def safe_filename(name: str) -> str:
    name = re.sub(r"[^A-Za-z0-9._-]+", "_", name).strip("_")
    return name or "invoice"


def fmt_money(value: float) -> str:
    return f"${value:,.2f}"


def fmt_units(value: float) -> str:
    if value == int(value):
        return str(int(value))
    return f"{value:g}"


def _build_field_values(lines: list[ServiceLine], participant: str) -> dict[str, str]:
    values: dict[str, str] = {"participant_name": participant}
    total_units = 0
    total_amount = 0.0
    for i, line in enumerate(lines, start=1):
        prefix = f"row{i}_"
        values[prefix + "date"] = line.visit_date.strftime("%m/%d/%y")
        values[prefix + "code"] = line.procedure_code
        values[prefix + "modifier"] = line.modifier
        values[prefix + "units"] = fmt_units(line.units)
        values[prefix + "rate"] = fmt_money(line.unit_rate)
        values[prefix + "unittype"] = UNIT_TYPE_LABEL
        values[prefix + "amount"] = fmt_money(line.amount)
        total_units += line.units
        total_amount += line.amount
    values["total_units"] = fmt_units(total_units)
    values["total_amount"] = fmt_money(total_amount)
    return values


def _set_field_font_sizes(writer: PdfWriter, sizes: dict[str, float]) -> None:
    """Shrink the default appearance font for narrow fields so text is not clipped."""
    for page in writer.pages:
        for annot in page.get("/Annots") or []:
            obj = annot.get_object()
            name = obj.get("/T")
            if name is None and "/Parent" in obj:
                obj = obj["/Parent"].get_object()
                name = obj.get("/T")
            if name in sizes:
                obj[NameObject("/DA")] = TextStringObject(f"/Helv {sizes[name]:g} Tf 0 g")


def fill_pdf(
    template_path: Path,
    field_values: dict[str, str],
    font_sizes: dict[str, float] | None = None,
) -> bytes:
    reader = PdfReader(str(template_path))
    writer = PdfWriter(clone_from=reader)

    # Ensure form field appearances render after fill (NeedAppearances flag).
    if "/AcroForm" not in writer._root_object:
        writer._root_object[NameObject("/AcroForm")] = writer._add_object({})
    acro = writer._root_object["/AcroForm"]
    acro[NameObject("/NeedAppearances")] = BooleanObject(True)

    if font_sizes:
        _set_field_font_sizes(writer, font_sizes)

    for page in writer.pages:
        writer.update_page_form_field_values(page, field_values)

    buf = io.BytesIO()
    writer.write(buf)
    return buf.getvalue()


@dataclass
class GeneratedInvoice:
    filename: str
    participant: str
    year: int
    month: int
    page_index: int
    page_count: int
    pdf_bytes: bytes


def generate_invoices(csv_text: str, template_path: Path) -> list[GeneratedInvoice]:
    grouped = parse_csv(csv_text)
    results: list[GeneratedInvoice] = []
    for (client, year, month), lines in sorted(grouped.items()):
        chunks = chunk_lines(lines, LINES_PER_PAGE)
        total_pages = len(chunks)
        for idx, chunk in enumerate(chunks, start=1):
            field_values = _build_field_values(chunk, client)
            pdf_bytes = fill_pdf(template_path, field_values)
            base = f"{safe_filename(client)}_{year:04d}-{month:02d}"
            suffix = f"_pt{idx}" if total_pages > 1 else ""
            results.append(
                GeneratedInvoice(
                    filename=f"{base}{suffix}.pdf",
                    participant=client,
                    year=year,
                    month=month,
                    page_index=idx,
                    page_count=total_pages,
                    pdf_bytes=pdf_bytes,
                )
            )
    return results
