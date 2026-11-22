"""Aggregate the two official Taxi 40100 weekly exports; output only fleet totals."""
import argparse
import csv
import io
import json
import re
from collections import Counter
from datetime import date, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from zoneinfo import ZoneInfo


def aggregate(card_file, invoice_file, week, exported_at):
    vienna = ZoneInfo("Europe/Vienna")
    end = week + timedelta(days=7)
    if week.weekday() != 0 or exported_at.tzinfo is None:
        raise ValueError("Monday and a timezone-aware export timestamp required")
    if not week <= exported_at.astimezone(vienna).date() < end:
        raise ValueError("Export is outside the interim week")
    vehicles = {}
    statuses = Counter()
    for path, key, time_field, id_field, allowed in [
        (card_file, "card", "Zeitpunkt", "Retrievalnummer", {"Erfasst", "Exportiert"}),
        (invoice_file, "invoice", "Fahrtbeginn", "Ver.FahrtID", {"Abgeschlossen"}),
    ]:
        raw = path.read_bytes()
        try:
            text = raw.decode("utf-8-sig")
        except UnicodeDecodeError:
            text = raw.decode("cp1252")
        reader = csv.DictReader(io.StringIO(text, newline=""), delimiter=";", strict=True)
        if not {"Fahrzeug", "Status", "Betrag", time_field, id_field}.issubset(reader.fieldnames or []):
            raise ValueError("Invalid export headers")
        seen = set()
        for row in reader:
            day = datetime.strptime(row[time_field].strip(), "%d.%m.%Y %H:%M:%S").date()
            vehicle, identity, status, amount = (row[k].strip() for k in ("Fahrzeug", id_field, "Status", "Betrag"))
            if not week <= day < end or not vehicle or not identity or identity in seen or status not in allowed:
                raise ValueError("Date, identifier or status requires review")
            if not re.fullmatch(r"(?:[0-9]+|[0-9]{1,3}(?:\.[0-9]{3})+),[0-9]{2}", amount):
                raise ValueError("Amount requires review")
            seen.add(identity)
            group = vehicles.setdefault(vehicle, {"name": vehicle, "counts": {"card": 0, "invoice": 0}, "values": {"card": 0, "invoice": 0}})
            group["counts"][key] += 1
            group["values"][key] += int(Decimal(amount.replace(".", "").replace(",", ".")) * 100)
            statuses[status] += 1
    stamp = exported_at.astimezone(vienna)
    return {"source": "Taxi 40100 · CSV", "partial": True, "exportedAt": stamp.isoformat(),
            "note": f"CSV-Stand {stamp:%d.%m.%Y %H:%M} (Wien). Karten/App: {statuses['Exportiert']} exportiert, {statuses['Erfasst']} erfasst. Rechnungsfahrten: {statuses['Abgeschlossen']} abgeschlossen.",
            "rows": [vehicles[k] for k in sorted(vehicles, key=lambda x: (len(x), x))]}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("cards", type=Path)
    parser.add_argument("invoices", type=Path)
    parser.add_argument("week", type=date.fromisoformat)
    parser.add_argument("exported_at", type=datetime.fromisoformat)
    args = parser.parse_args()
    print(json.dumps(aggregate(args.cards, args.invoices, args.week, args.exported_at), ensure_ascii=False))
