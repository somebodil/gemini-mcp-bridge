# Privacy policy of Gemini MCP Bridge

Gemini MCP Bridge is a Chrome extension. It collects no data for its developer and sends nothing to its developer or to any third party.

## What the extension reads

- **The page of gemini.google.com.** The extension reads Gemini's replies to find the tool calls in them, and reads the input box. It does this only on gemini.google.com.
- **Its settings**, kept with `chrome.storage.local` in your browser: the addresses and tokens of your MCP servers, your choice for each tool (ask, auto, off), and the behavior options. It also keeps, for each Gemini conversation, a short hash of the tool list sent to it, so that the list is not sent twice.

## Where data goes

- **To MCP servers on your own computer.** The extension sends the tool calls Gemini writes to the MCP servers you entered in the options. It can reach only `127.0.0.1` and `localhost`.
- **To Gemini.** The extension types the instructions, your tool list and the results of the tool calls into your Gemini conversation. They then are messages of that conversation, which Google handles under its own terms and privacy policy, like everything else you type into Gemini.

Nothing else leaves your browser. The extension has no analytics and no remote code, and it makes no requests to other servers.

## The local server

The matching local server ([gemini-mcp-bridge-server](https://github.com/somebodil/gemini-mcp-bridge-server)) is a separate program. It runs on your computer, listens on `127.0.0.1` only, and keeps its settings in a file on your computer. It sends nothing anywhere, except what the MCP servers you configure do on their own.

## Contact

Questions: open an issue in the project's repository.
