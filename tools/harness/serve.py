"""Serves /repo/* from the project and /scratch/* from the scratchpad, one origin."""
import http.server
import os
import sys

REPO = sys.argv[1]
SCRATCH = sys.argv[2]
PORT = int(sys.argv[3])


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      '.mjs': 'text/javascript', '.js': 'text/javascript', '.wasm': 'application/wasm'}

    def translate_path(self, path):
        path = path.split('?', 1)[0].split('#', 1)[0]
        for prefix, root in (('/repo/', REPO), ('/scratch/', SCRATCH)):
            if path.startswith(prefix):
                rel = path[len(prefix):]
                full = os.path.normpath(os.path.join(root, *rel.split('/')))
                if full.startswith(os.path.normpath(root)):
                    return full
        return os.path.join(SCRATCH, '__nothing__')

    def do_PUT(self):
        # Harness output only, into scratch/out.
        name = os.path.basename(self.path.split('?', 1)[0])
        os.makedirs(os.path.join(SCRATCH, 'out'), exist_ok=True)
        data = self.rfile.read(int(self.headers.get('Content-Length', 0)))
        with open(os.path.join(SCRATCH, 'out', name), 'wb') as f:
            f.write(data)
        self.send_response(204)
        self.end_headers()


http.server.ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
