import sqlite3, json

conn = sqlite3.connect('data/aea-transcripts.db')
c = conn.cursor()

# Check event types and their metadata
c.execute("SELECT session_id, event_type, metadata FROM events WHERE session_id LIKE 'f2a67f4d%' LIMIT 30")
rows = c.fetchall()
print("=== Events from session f2a67f4d (first 30) ===")
for sid, etype, meta_str in rows:
    meta = json.loads(meta_str) if meta_str else {}
    # Show key fields
    msg_len = meta.get('messageLength', meta.get('responseLength', ''))
    tool = meta.get('toolName', '')
    file_path = meta.get('file', meta.get('path', ''))
    success = meta.get('success', '')
    source = meta.get('source', '')
    print(f"  {etype}: msgLen={msg_len} tool={tool} file={file_path} success={success} source={source}")

# Count event types
c.execute("SELECT event_type, COUNT(*) FROM events WHERE session_id LIKE 'f2a67f4d%' GROUP BY event_type")
print("\n=== Event type counts ===")
for etype, count in c.fetchall():
    print(f"  {etype}: {count}")

# Check a chat event specifically
c.execute("SELECT event_type, metadata FROM events WHERE session_id LIKE 'f2a67f4d%' AND event_type='chat' LIMIT 5")
print("\n=== Chat events metadata ===")
for etype, meta_str in c.fetchall():
    meta = json.loads(meta_str) if meta_str else {}
    print(f"  {json.dumps(meta)}")

conn.close()
