import sys, os
sys.path.insert(0, os.path.dirname(__file__))
from server_python.main import app, PORT
print(f"MMB Python Server starting on http://127.0.0.1:{PORT}")
app.run(host="127.0.0.1", port=PORT, debug=False, threaded=True)
