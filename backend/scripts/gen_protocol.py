"""Export the wire protocol as JSON Schema for the frontend type generator.

python scripts/gen_protocol.py   (then `npm run gen:protocol` in frontend/)
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from pydantic import BaseModel

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.game.events import GameEvent  # noqa: E402
from app.realtime.protocol import (  # noqa: E402
    PROTOCOL_VERSION,
    ClientMessage,
    GuestSession,
    RoomView,
    ServerMessage,
)

OUT = Path(__file__).resolve().parents[2] / "frontend" / "protocol.schema.json"


class Protocol(BaseModel):
    """Root type that pulls every wire model into one schema."""

    server: ServerMessage
    client: ClientMessage
    event: GameEvent
    room: RoomView
    guest: GuestSession


def _strip_field_titles(node: object) -> None:
    """Pydantic titles every field; that makes the TS generator emit an alias per field."""
    if isinstance(node, dict):
        props = node.get("properties")
        if isinstance(props, dict):
            for prop in props.values():
                if isinstance(prop, dict):
                    prop.pop("title", None)
        for value in node.values():
            _strip_field_titles(value)
    elif isinstance(node, list):
        for value in node:
            _strip_field_titles(value)


def main() -> None:
    schema = Protocol.model_json_schema(by_alias=True, mode="serialization")
    _strip_field_titles(schema["$defs"])
    # Name the root unions so they become exported TypeScript types.
    titles = {"server": "ServerMessage", "client": "ClientMessage", "event": "GameEvent", "room": None, "guest": None}
    for key, title in titles.items():
        prop = schema["properties"][key]
        if title:
            prop["title"] = title
        else:
            prop.pop("title", None)
    # The server always sends every field (defaults included), so mark them required.
    for definition in schema["$defs"].values():
        if "properties" in definition:
            definition["required"] = sorted(definition["properties"])
    schema["title"] = "Protocol"
    schema["description"] = f"Ludo Brawl wire protocol v{PROTOCOL_VERSION}. Generated - do not edit."
    OUT.write_text(json.dumps(schema, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    print("wrote", OUT)


if __name__ == "__main__":
    main()
