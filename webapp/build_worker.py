"""Rebuild worker.js by embedding the local template HTML."""

with open('webapp/templates/index.html', 'r', encoding='utf-8') as f:
    html = f.read()

# Escape backticks and dollar-braces for JS template literal
html = html.replace('\\', '\\\\').replace('`', '\\`').replace('${', '\\${')

# Read worker JS and find the marker line
with open('webapp/worker/worker.js', 'r', encoding='utf-8') as f:
    content = f.read()

marker = '// --- Embedded Frontend HTML ---'
idx = content.find(marker)
if idx == -1:
    raise RuntimeError('Marker not found in worker.js')

js_part = content[:idx]

worker = js_part + marker + '\n\nconst HTML = `' + html + '`;\n'

with open('webapp/worker/worker.js', 'w', encoding='utf-8') as f:
    f.write(worker)

print(f'Worker rebuilt: {len(worker)} chars')
