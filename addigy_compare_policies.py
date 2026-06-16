#!/usr/bin/env python3
"""
Addigy Policy Comparator
Fetches two policies by name or ID and prints a structured diff.
"""

import json
import sys
import argparse
import requests
from deepdiff import DeepDiff

API_BASE = "https://app.addigy.com/api/v2"
API_KEY  = "ad2512ee1dd8a9e91c5a838b477015a1"
ORG_ID   = "d3567f03-cc8f-4033-ae98-d82e4bcdeb15"

HEADERS = {
    "Authorization": f"Bearer {API_KEY}",
    "addigy-org-id": ORG_ID,
    "Content-Type": "application/json",
}


def get_all_policies() -> list[dict]:
    resp = requests.get(f"{API_BASE}/policies", headers=HEADERS, timeout=30)
    resp.raise_for_status()
    return resp.json()


def find_policy(policies: list[dict], identifier: str) -> dict:
    """Find a policy by its ID or name (case-insensitive)."""
    for p in policies:
        if p.get("id") == identifier or p.get("name", "").lower() == identifier.lower():
            return p
    raise ValueError(f"Policy not found: {identifier!r}")


def get_policy_detail(policy_id: str) -> dict:
    """Fetch full policy detail including instructions/items."""
    resp = requests.get(f"{API_BASE}/policies/{policy_id}", headers=HEADERS, timeout=30)
    resp.raise_for_status()
    return resp.json()


def print_diff(policy_a: dict, policy_b: dict, name_a: str, name_b: str):
    diff = DeepDiff(policy_a, policy_b, ignore_order=True, verbose_level=2)

    if not diff:
        print(f"\n✅  Policies '{name_a}' and '{name_b}' are IDENTICAL.\n")
        return

    print(f"\n{'='*60}")
    print(f"  POLICY DIFF: '{name_a}'  vs  '{name_b}'")
    print(f"{'='*60}\n")

    if "dictionary_item_added" in diff:
        print("── ADDED in B (not in A) ──────────────────────────────────")
        for item in diff["dictionary_item_added"]:
            print(f"  + {item}")
        print()

    if "dictionary_item_removed" in diff:
        print("── REMOVED from B (present in A) ──────────────────────────")
        for item in diff["dictionary_item_removed"]:
            print(f"  - {item}")
        print()

    if "values_changed" in diff:
        print("── CHANGED VALUES ─────────────────────────────────────────")
        for key, change in diff["values_changed"].items():
            print(f"  {key}")
            print(f"    A: {change['old_value']}")
            print(f"    B: {change['new_value']}")
        print()

    if "iterable_item_added" in diff:
        print("── LIST ITEMS ADDED in B ───────────────────────────────────")
        for key, val in diff["iterable_item_added"].items():
            print(f"  + {key}: {json.dumps(val, indent=4)}")
        print()

    if "iterable_item_removed" in diff:
        print("── LIST ITEMS REMOVED from B ───────────────────────────────")
        for key, val in diff["iterable_item_removed"].items():
            print(f"  - {key}: {json.dumps(val, indent=4)}")
        print()

    if "type_changes" in diff:
        print("── TYPE CHANGES ────────────────────────────────────────────")
        for key, change in diff["type_changes"].items():
            print(f"  {key}: {change['old_type'].__name__} → {change['new_type'].__name__}")
        print()


def main():
    parser = argparse.ArgumentParser(description="Compare two Addigy policies.")
    parser.add_argument("policy_a", help="Name or ID of the first policy")
    parser.add_argument("policy_b", help="Name or ID of the second policy")
    parser.add_argument("--list", action="store_true", help="List all available policies and exit")
    parser.add_argument("--json", dest="as_json", action="store_true", help="Output raw diff as JSON")
    args = parser.parse_args()

    try:
        policies = get_all_policies()
    except requests.HTTPError as e:
        print(f"Error fetching policies: {e}\nResponse: {e.response.text}", file=sys.stderr)
        sys.exit(1)

    if args.list:
        print(f"\n{'ID':<40}  NAME")
        print("-" * 70)
        for p in policies:
            print(f"{p.get('id',''):<40}  {p.get('name','')}")
        print()
        return

    try:
        pol_a = find_policy(policies, args.policy_a)
        pol_b = find_policy(policies, args.policy_b)
    except ValueError as e:
        print(f"Error: {e}", file=sys.stderr)
        print("\nAvailable policies:")
        for p in policies:
            print(f"  {p.get('id','')}  {p.get('name','')}")
        sys.exit(1)

    # Fetch full details
    detail_a = get_policy_detail(pol_a["id"])
    detail_b = get_policy_detail(pol_b["id"])

    if args.as_json:
        diff = DeepDiff(detail_a, detail_b, ignore_order=True, verbose_level=2)
        print(json.dumps(diff, indent=2, default=str))
    else:
        print_diff(detail_a, detail_b, pol_a.get("name", args.policy_a), pol_b.get("name", args.policy_b))


if __name__ == "__main__":
    main()
