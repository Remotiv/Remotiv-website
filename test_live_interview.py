"""
Quick test: create a session on VoxAgent and run a text-based interview via WebSocket.

Usage (from project root, with VoxAgent server running on port 8000):
    pixi run python test_live_interview.py
"""

import asyncio
import json
import uuid
import httpx
import websockets


VOXAGENT_URL = "http://localhost:8000"

QUESTIONS = [
    {"id": str(uuid.uuid4()), "text": "Tell me about yourself and your experience.", "position": 1},
    {"id": str(uuid.uuid4()), "text": "What is your greatest strength?", "position": 2},
]


async def main():
    print("=== VoxAgent Live Interview Test ===\n")

    # 1. Health check
    async with httpx.AsyncClient() as client:
        r = await client.get(f"{VOXAGENT_URL}/v1/health")
        print(f"Health: {r.json()}\n")

        # 2. Create session (default 30-min duration, override with duration_minutes)
        #    If questions=[] and cv_text is provided, questions are generated from the CV.
        r = await client.post(
            f"{VOXAGENT_URL}/v1/sessions",
            json={
                "session_id": "test-session-001",
                "interviewer_name": "Sarah",
                "candidate_first_name": "Alex",
                "questions": QUESTIONS,
                "duration_minutes": 5,
            },
        )
        session = r.json()
        print(f"Session created: {json.dumps(session, indent=2)}\n")

    ws_url = f"ws://localhost:8000{session['ws_url']}?token={session['ws_token']}"
    print(f"Connecting to: {ws_url}\n")

    async with websockets.connect(ws_url) as ws:
        answered = 0

        while True:
            try:
                msg = await asyncio.wait_for(ws.recv(), timeout=120)
            except asyncio.TimeoutError:
                print("[timeout] No message in 120s, exiting")
                break

            if isinstance(msg, bytes):
                print(f"  [audio] {len(msg)} bytes")
                continue

            data = json.loads(msg)
            msg_type = data.get("type", "")
            print(f"  [{msg_type}] {json.dumps(data)}")

            if msg_type == "listening":
                answered += 1
                if answered <= len(QUESTIONS):
                    await asyncio.sleep(1)
                    print(f"\n>>> Sending text answer for Q{answered}...")
                    await ws.send(json.dumps({
                        "type": "text_input",
                        "text": f"Well, I have 5 years of experience in software engineering. "
                                f"I worked at a startup where I built their core API platform "
                                f"and led a team of 3 engineers. We shipped the product in 6 months "
                                f"and grew to 10,000 users.",
                    }))
                else:
                    print("\n>>> All questions answered, ending session...")
                    await ws.send(json.dumps({"type": "end_session"}))

            elif msg_type == "session_complete":
                print(f"\n=== Interview complete: {data.get('reason')} ===")
                break

    # 3. Finalize
    async with httpx.AsyncClient() as client:
        r = await client.post(f"{VOXAGENT_URL}/v1/sessions/test-session-001/finalize")
        result = r.json()
        print(f"\nFinal transcript ({len(result.get('turns', []))} turns):")
        for turn in result.get("turns", []):
            role = turn["role"]
            text = turn["text"][:100]
            turn_id = turn.get("turn_id", "?")[:8]
            base_q = turn.get("base_question_id", "?")[:8] if turn.get("base_question_id") else "none"
            offset = turn.get("offset_seconds", "?")
            audio_dur = turn.get("audio_duration_seconds")
            audio_str = f"{audio_dur:.1f}s" if audio_dur is not None else "null"
            follow_reason = turn.get("follow_up_reason", "")
            reason_str = f" reason={follow_reason}" if follow_reason else ""
            iv_audio = turn.get("interviewer_audio_file", "")
            iv_str = f" iv_audio={iv_audio}" if iv_audio else ""
            print(f"  [{role}] tid={turn_id}.. bqid={base_q}.. offset={offset}s "
                  f"audio={audio_str}{iv_str}{reason_str} | {text}{'...' if len(turn['text']) > 100 else ''}")
        print(f"\nDuration: {result.get('duration_seconds', 0):.1f}s")


if __name__ == "__main__":
    asyncio.run(main())
