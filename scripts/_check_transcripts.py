import json, glob

files = glob.glob('/Users/saga/Library/Application Support/Code/User/workspaceStorage/*/GitHub.copilot-chat/transcripts/*.jsonl')
for f in files[:3]:
    print(f'--- {f.split("/")[-1]} ---')
    for line in open(f):
        obj = json.loads(line)
        t = obj.get('type', '')
        data = obj.get('data', {})
        if t == 'user.message':
            content = str(data.get('content', ''))
            print(f'  user.message: content_len={len(content)}')
            if len(content) > 0:
                print(f'    preview: {content[:100]}')
            else:
                print(f'  data keys: {list(data.keys())}')
                for k, v in data.items():
                    s = str(v)[:120]
                    print(f'    {k} ({type(v).__name__}): {s}')
        elif t == 'tool.execution_start':
            name = data.get('toolName', '?')
            args = data.get('arguments', {}) or {}
            arg_keys = list(args.keys())
            has_file = any(k in args for k in ['filePath', 'path', 'file', 'fileName'])
            print(f'  tool.start: name={name} arg_keys={arg_keys} has_file={has_file}')
        elif t == 'tool.execution_complete':
            name = data.get('toolName', '?')
            success = data.get('success', '?')
            print(f'  tool.complete: name={name} success={success}')
