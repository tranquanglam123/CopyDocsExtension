# 📋 CopyDocExt

**Extract content from restricted Google Docs, Sheets, and Slides.**

When a Google document has download/copy restrictions enabled, this extension bypasses those restrictions by navigating to the document's mobile view (`/mobilebasic`) with JavaScript disabled, extracting the content with formatting preserved.

---

## ✨ Features

- **Copy with formatting** — Paste into Google Docs or Word with bold, headings, tables preserved
- **Open in New Doc** — One-click: copies content → opens a blank Google Doc → you press Ctrl+V
- **Download .docx** — Proper Office 2007+ Word document with formatting
- **Download .txt** — Plain text fallback
- **Popup recovery** — If the popup closes during extraction, just re-click the icon to see your results

---

## 🚀 Installation

### Option 1: Quick Install (Windows)

1. Download or clone this repository
2. Double-click **`install.bat`** — it will open Chrome's extension page for you
3. Follow the on-screen instructions (also shown below)

### Option 2: Manual Install (Any OS)

1. **Download** this repository — click the green **Code** button → **Download ZIP**, then unzip it  
   *Or* clone with git: `git clone https://github.com/YOUR_USERNAME/CopyDocExt.git`

2. Open **Google Chrome** and go to:
   ```
   chrome://extensions
   ```

3. Enable **Developer mode** — toggle the switch in the top-right corner

4. Click **"Load unpacked"** (top-left button)

5. Select the **CopyDocExt** folder (the one containing `manifest.json`)

6. ✅ Done! You'll see the CopyDocExt icon in your toolbar. If it's hidden, click the puzzle piece icon 🧩 and pin it.

---

## 📖 How to Use

### Step 1: Open a restricted Google Doc

Navigate to any Google Doc, Sheet, or Slide that has download/copy restrictions.

### Step 2: Click the extension icon

Click the **CopyDocExt** icon in your Chrome toolbar. The popup will show whether a valid document was detected.

### Step 3: Extract content

Click **"Extract Content"**. The extension will:
- Block JavaScript on the tab
- Navigate to the mobile view (`/mobilebasic`)
- Extract all text with formatting
- Restore JavaScript

> **Note:** The popup may close briefly during navigation. Just click the icon again — your results will be there.

### Step 4: Export your content

Choose one of the four export options:

| Button | What it does |
|--------|-------------|
| **Copy** | Copies with formatting — paste into Google Docs, Word, or any rich text editor |
| **New Doc** | Copies content + opens a blank Google Doc. Press **Ctrl+V** to paste |
| **.docx** | Downloads a Word document with formatting (headings, bold, tables) |
| **.txt** | Downloads plain text |

---

## ❓ Troubleshooting

| Problem | Solution |
|---------|----------|
| Extension icon not visible | Click the puzzle piece 🧩 in Chrome toolbar → Pin CopyDocExt |
| "Not a Google Doc" error | Make sure you're on a `docs.google.com` page |
| Extraction times out | The document may be very large — try again, or check your internet connection |
| Popup closed during extraction | Just click the icon again — results are saved automatically |
| .docx won't open | Try opening with Google Docs (upload to Drive) or LibreOffice |

---

## 🔒 Privacy

This extension:
- **Does NOT send any data** to external servers
- **Does NOT collect** any personal information
- Works **entirely offline** after installation
- Only activates on `docs.google.com` pages

---

## 📁 Project Structure

```
CopyDocExt/
├── manifest.json            # Extension configuration
├── background/
│   └── service-worker.js    # Orchestrator (extraction pipeline)
├── content/
│   └── content-script.js    # DOM scanner (extracts formatted text)
├── popup/
│   ├── popup.html           # Popup UI
│   ├── popup.css            # Dark theme styles
│   └── popup.js             # UI logic, clipboard, downloads
├── lib/
│   ├── url-transformer.js   # URL manipulation utility
│   ├── mini-zip.js          # Pure-JS ZIP creator (no dependencies)
│   └── docx-generator.js    # HTML → Office Open XML converter
├── icons/                   # Extension icons
├── rules/                   # Declarative net request rules
├── install.bat              # Windows quick-install helper
├── LICENSE                  # MIT License
└── README.md                # This file
```

---

## 📄 License

This project is licensed under the **MIT License** — see [LICENSE](LICENSE) for details.

Free for personal and educational use.

---

## ⚠️ Disclaimer

This tool is intended for **personal and educational use only**. Please respect content creators' rights and your organization's policies when using this extension. The authors are not responsible for any misuse.
