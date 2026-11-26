# Privacy policy of Gemini MCP Bridge

Gemini MCP Bridge is a Chrome extension. It collects no data for its developer and sends nothing to its developer or to any third party.

## What the extension reads

- **The chat page in the tabs where you turn it on.** The extension goes into a tab only when you click its icon there, and leaves when you click it again (or the tab goes to another site). In such a tab it reads the replies to find the tool calls in them, and reads the input box. It does not read other tabs or other sites.
- **The page's structure, when you ask for it.** *Copy page structure* puts the names of the page's elements on your clipboard (no texts of the page). It goes nowhere unless you paste it somewhere.
- **How a chat page is built, when you ask the extension to learn it.** *Learn this page* puts a test message into the input box, which you send yourself, and watches the page answer it. It keeps, for that site, how to find the input box, the buttons, the messages and the code blocks again: CSS selectors made of element names, classes and attributes, and the label of the button that shows the page is writing. And which AI answered (Claude, ChatGPT, Gemini, or another), from the name its reply gave: the instructions then tell that AI where its own folder on your computer is. No other texts of the page or of your messages. The options page lists the learned sites and deletes them.
- **How slow the page is, when you turn on the performance log** (an option, off by default). In the tabs where the extension is on, it writes down the clicks, keys and frames that took long, how much of that time was its own work, and every minute how much time it took. The lines carry names and numbers only: the site without its path, the tag and classes of the element clicked, and the hosts and file names of the page's scripts that ran long. No texts of the page. The last lines are kept in your browser's session storage (gone when the browser closes) for the options page, which copies and clears them.
- **Its settings**, kept with `chrome.storage.local` in your browser: the addresses and tokens of your MCP servers, your choice for each tool (ask, auto, off) and the sites where the auto tools run without asking, and the behavior options, and what it learned about chat pages (above). It also keeps, for each conversation, a short hash of the tool list sent to it, so that the list is not sent twice, and (in the page's own storage) where you dragged the corner button.

## Where data goes

- **To MCP servers on your own computer.** The extension sends the tool calls Gemini writes to the MCP servers you entered in the options. It can reach only `127.0.0.1` and `localhost`. While the performance log is on, its lines go to local-mcp-bridge-server among them (or gemini-mcp-bridge-server, its name until 0.6.0; no other server), which writes them into a file on that computer.
- **To Gemini.** The extension types the instructions, your tool list and the results of the tool calls into your Gemini conversation. They then are messages of that conversation, which Google handles under its own terms and privacy policy, like everything else you type into Gemini.

Nothing else leaves your browser. The extension has no analytics and no remote code, and it makes no requests to other servers.

## The local server

The matching local server ([local-mcp-bridge-server](https://github.com/somebodil/local-mcp-bridge-server)) is a separate program. It runs on your computer, takes only requests that carry its token, and keeps its settings (and the performance log, when the extension sends one) in files on your computer. It sends nothing anywhere, except what the MCP servers you configure do on their own.

## Contact

Questions: open an issue in the project's repository.
