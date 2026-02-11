# Cursor Chat Browser

A web application for browsing and managing chat histories from the Cursor editor's AI chat feature. View, search, and export your AI conversations in various formats.

## Features

- 🔍 Browse and search all workspaces with Cursor chat history
- 🌐 Support for both workspace-specific and global storage (newer Cursor versions)
- 🤖 View both AI chat logs and Composer logs
- 📁 Organize chats by workspace
- 🔎 Full-text search with filters for chat/composer logs
- 📱 Responsive design with dark/light mode support
- ⬇️ Export chats as:
  - Markdown files
  - HTML documents (with syntax highlighting)
  - PDF documents
- 🎨 Syntax highlighted code blocks
- 📌 Bookmarkable chat URLs
- ⚙️ Automatic workspace path detection

## Prerequisites

- Node.js 18+ and npm
- A Cursor editor installation with chat history

## Installation

1. Clone the repository:
  ```bash
  git clone https://github.com/thomas-pedersen/cursor-chat-browser.git
  cd cursor-chat-browser
  ```

2. Install dependencies:
  ```bash
  npm install
  ```

3. Start the development server:
  ```bash
  npm run dev
  ```

4. Open [http://localhost:3000](http://localhost:3000) in your browser

## Configuration

The application automatically detects your Cursor workspace storage location based on your operating system:

- Windows: `%APPDATA%\Cursor\User\workspaceStorage`
- WSL2: `/mnt/c/Users/<USERNAME>/AppData/Roaming/Cursor/User/workspaceStorage`
- macOS: `~/Library/Application Support/Cursor/User/workspaceStorage`
- Linux: `~/.config/Cursor/User/workspaceStorage`
- Linux (remote/SSH): `~/.cursor-server/data/User/workspaceStorage`

If automatic detection fails, you can manually set the path in the Configuration page (⚙️).

**Note:** Recent versions of Cursor have moved chat data storage from workspace-specific locations to global storage. This application now supports both storage methods to ensure compatibility with all Cursor versions.

## Troubleshooting

### Node.js Version Issues on Windows

If you encounter compilation errors during `npm install` related to `better-sqlite3` and `node-gyp`, this is typically caused by using a very new or unsupported Node.js version.

**Error symptoms:**
```
gyp ERR! find VS Could not find any Visual Studio installation to use
gyp ERR! configure error
```

**Solution 1: Use Node.js LTS (Recommended)**

The `better-sqlite3` package requires native compilation and works best with Node.js LTS versions that have prebuilt binaries available.

If you're using `nvm` (Node Version Manager):
```bash
# Install and use Node.js 20 LTS
nvm install 20
nvm use 20

# Clean up and reinstall
rm -rf node_modules package-lock.json
npm install
```

**Solution 2: Install Windows Build Tools**

If you must use a newer Node.js version (e.g., v24+), you'll need to install Visual Studio with C++ build tools:

1. Download Visual Studio Build Tools from https://visualstudio.microsoft.com/downloads/
2. Install the "Desktop development with C++" workload
3. Run `npm install` again

**Note:** We recommend using Node.js 18 or 20 LTS for the best compatibility and to avoid build tool requirements.

## Usage

### Browsing Logs
- View all workspaces on the home page
- Browse AI chat logs by workspace
- Access Composer logs from the navigation menu
- Navigate between different chat tabs within a workspace
- View combined logs with type indicators
- See chat and composer counts per workspace

### Searching
- Use the search bar in the navigation to search across all logs
- Filter results by chat logs, composer logs, or both
- Search results show:
  - Type badge (Chat/Composer)
  - Matching text snippets
  - Workspace location
  - Title
  - Timestamp

### Exporting
Each log can be exported as:
- Markdown: Plain text with code blocks
- HTML: Styled document with syntax highlighting
- PDF: Formatted document suitable for sharing

## Development

Built with:
- Next.js 14 (App Router)
- TypeScript
- Tailwind CSS
- shadcn/ui components
- SQLite for reading Cursor's chat database

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for a list of changes.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.