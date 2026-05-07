#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# setup-python.sh  —  Install Python OCR dependencies for Replit VM
# Run once after cloning: bash setup-python.sh
# Safe to re-run: skips install if packages already present.
# ─────────────────────────────────────────────────────────────────────────────

set -e

VENV_DIR=".venv"
REQUIREMENTS="identity_service/requirements.txt"

echo "=== Python OCR Setup ==="

# Check Python
if ! command -v python3 &>/dev/null; then
  echo "ERROR: python3 not found. Ensure the Replit environment includes Python 3."
  exit 1
fi

echo "Python: $(python3 --version)"

# Create venv if it doesn't exist
if [ ! -d "$VENV_DIR" ]; then
  echo "Creating virtual environment at $VENV_DIR ..."
  python3 -m venv "$VENV_DIR"
else
  echo "Virtual environment already exists at $VENV_DIR"
fi

# Activate venv
source "$VENV_DIR/bin/activate"

# Upgrade pip silently
pip install --upgrade pip --quiet

# Install requirements
if [ -f "$REQUIREMENTS" ]; then
  echo "Installing packages from $REQUIREMENTS ..."
  pip install -r "$REQUIREMENTS" --quiet
  echo "Packages installed successfully."
else
  echo "ERROR: $REQUIREMENTS not found."
  exit 1
fi

# Pre-download EasyOCR model into .ocr-cache so first request isn't slow
echo "Pre-downloading EasyOCR model (this may take 1-2 minutes on first run)..."
python3 -c "
import easyocr, pathlib
cache = pathlib.Path('.ocr-cache')
model_dir = cache / 'model'
user_net_dir = cache / 'user-network'
model_dir.mkdir(parents=True, exist_ok=True)
user_net_dir.mkdir(parents=True, exist_ok=True)
reader = easyocr.Reader(['en'], gpu=False, model_storage_directory=str(model_dir), user_network_directory=str(user_net_dir))
print('EasyOCR model ready.')
" 2>&1 | grep -v "^$" || echo "Model download attempted."

echo ""
echo "=== Setup Complete ==="
echo "Python OCR sidecar will start automatically when the app boots."
echo "To disable it: set ENABLE_PYTHON_OCR=false in Replit Secrets."
