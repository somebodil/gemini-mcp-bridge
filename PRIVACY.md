# Privacy policy of Gemini MCP Bridge

Gemini MCP Bridge is a Chrome extension. It collects no data for its developer and sends nothing to its developer or to any third party.

## What the extension reads

- **The chat page in the tabs where you turn it on.** The extension goes into a tab only when you click its icon there, and leaves when you click it again (or the tab goes to another site). In such a tab it reads the replies to find the tool calls in them, and reads the input box. It does not read other tabs or other sites.
- **The page's structure, when you ask for it.** *Copy page structure* puts the names of the page's elements on your clipboard (no texts of the page). It goes nowhere unless you paste it somewhere.
- **Its settings**, kept with `chrome.storage.local` in your browser: the addresses and tokens of your MCP servers, your choice for each tool (ask, auto, off), and the behavior options. It also keeps, for each conversation, a short hash of the tool list sent to it, so that the list is not sent twice, and (in the page's own storage) where you dragged the corner button.

## Where data goes

- **To MCP servers on your own computer.** The extension sends the tool calls Gemini writes to the MCP servers you entered in the options. It can reach only `127.0.0.1` and `localhost`.
- **To Gemini.** The extension types the instructions, your tool list and the results of the tool calls into your Gemini conversation. They then are messages of that conversation, which Google handles under its own terms and privacy policy, like everything else you type into Gemini.

Nothing else leaves your browser. The extension has no analytics and no remote code, and it makes no requests to other servers.

## The local server

The matching local server ([gemini-mcp-bridge-server](https://github.com/somebodil/gemini-mcp-bridge-server)) is a separate program. It runs on your computer, listens on `127.0.0.1` only, and keeps its settings in a file on your computer. It sends nothing anywhere, except what the MCP servers you configure do on their own.

## Contact

Questions: open an issue in the project's repository.
