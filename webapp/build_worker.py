"""Rebuild worker.js by embedding the local template HTML."""

with open('webapp/templates/index.html', 'r', encoding='utf-8') as f:
    html = f.read()

# Escape backticks and dollar-braces for JS template literal
html = html.replace('\\', '\\\\').replace('`', '\\`').replace('${', '\\${')

# Read worker JS (lines 1-183 = the JS logic before the HTML)
with open('webapp/worker/worker.js', 'r', encoding='utf-8') as f:
    lines = f.readlines()

js_part = ''.join(lines[:183])

worker = js_part + '\n// --- Embedded Frontend HTML ---\n\nconst HTML = `' + html + '`;\n'

with open('webapp/worker/worker.js', 'w', encoding='utf-8') as f:
    f.write(worker)

print(f'Worker rebuilt: {len(worker)} chars')
