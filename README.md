# Gemini MCP Bridge

Gemini on the web ([gemini.google.com](https://gemini.google.com)) gets the tools of your own computer: your shell, your files, and any MCP server you run. You chat as usual; when Gemini needs your computer, it calls a tool, and the answer comes back by itself.

This is the Chrome extension. It works with a local MCP server, because an extension cannot touch your computer by itself:

- **[gemini-mcp-bridge-server](https://github.com/somebodil/gemini-mcp-bridge-server)**, the matching server: shell and file tools, plus any MCP servers you list. Start it with `npx gemini-mcp-bridge-server`.
- **Any other MCP server** on `127.0.0.1` or `localhost` that speaks Streamable HTTP.

## How it works

Gemini on the web has no API for outside tools, so the extension works through the chat itself:

1. When you send the first message of a conversation, the extension puts instructions and the list of your tools in front of it. On the page they collapse into a chip: `🔧 MCP Bridge instructions · 4 tools`.
2. When Gemini needs a tool, it answers with a code block like this one, and stops:

   ```json
   {"mcp_call": {"tool": "read_file", "arguments": {"path": "~/notes/todo.md"}}}
   ```

3. The extension shows a card under the block. It runs the call when you press **Run**, or at once for tools you allowed. The call goes to the MCP server on your computer.
4. The extension types the results into the input box and sends them. On the page they collapse into a chip too. Gemini continues: it calls more tools or answers you.

Gemini does not know an extension exists. It follows the instructions in the conversation, as it would follow any other instructions.

## Install

1. **Start the local server** (Node.js 20 or later). Its first start prints a URL and a token:

   ```bash
   npx gemini-mcp-bridge-server
   ```

2. **Add the extension to Chrome:** from the Chrome Web Store, or from a release zip ([Releases](../../releases)). For a zip: unzip it, open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and choose the folder.
3. **Connect them:** the options page opens after the install (later: the extension's icon > **Settings**). Enter the URL and the token, then press **Test**. It should say *Connected · 4 tools*.
4. **Use it:** open Gemini and ask something that needs your computer, for example *"What are the largest files in my Downloads folder?"*. A small button in the lower right corner of Gemini's page shows the state, and turns the tools off for one chat.

## Safety

Read this before you allow a tool to run by itself.

- **Calls wait for you.** By default every call waits for your **Run**. *Always allow* (or the options page) lets one tool run without asking. *Run every tool without asking* exists, but it means that whatever Gemini writes runs.
- **Gemini's text is not trustworthy.** A web page, a document or an email that Gemini reads can carry instructions of its own ("prompt injection"). Keep tools that run commands or write files on **Ask** unless you watch closely.
- **Old conversations never run calls.** A reply is handled only if this tab saw Gemini write it. Opening an old chat, reloading the page or switching chats runs nothing.
- **Local only.** The extension may reach only `127.0.0.1` and `localhost`.
- **What Google sees.** The instructions, the tool list and every tool result become messages of your Gemini conversation. Google stores and uses them like everything else you type into Gemini. Do not let Gemini read files you would not paste into Gemini yourself.
- **A loop guard.** After 20 automatic rounds without a message from you, the extension pauses and asks before it continues (the number is in the options).

## Options

- **MCP servers:** any number of them, each with a URL and an optional token (sent as `Authorization: Bearer`). If two servers have a tool of the same name, the server's name goes in front of it.
- **Tools:** *Ask*, *Auto* or *Off* for each tool. Gemini is not told about tools that are off.
- **Behavior:**
    - Send the results by itself, or leave them in the input box.
    - How many automatic rounds before a pause.
    - How many characters of output go into one message (20,000 by default).
    - The time limit of a call.

## Limits

- The extension reads and writes Gemini's page, which Google can change at any time. When Gemini changes its page, the extension may stop working until it is updated. All of what it relies on is in [`src/content/gemini.ts`](src/content/gemini.ts).
- Gemini follows the protocol well, but it is a protocol in text: now and then Gemini writes a call in the wrong shape, or forgets the instructions in a very long conversation. A call it cannot read gets an error back, so that Gemini can write it again. When the tool list changes, the next message carries the new list.
- Images, audio and other binary output of tools reach Gemini only as a short note (`[image: image/png, 120 KB, not shown]`).
- Only Chrome, and only gemini.google.com.

## Privacy

The extension sends nothing to its developer or to anyone else: see [PRIVACY.md](PRIVACY.md).

## Development

```bash
npm install
npm run check     # types, lint, unit tests (the MCP client against servers made with the official SDK)
npm run build     # dist/extension: load it with "Load unpacked"
npm run e2e       # the built extension in Chromium against a mock of Gemini's page
npm run e2e:live  # against the real gemini.google.com, signed out
```

With `localStorage["gmb-debug"] = "1"` on gemini.google.com, the extension writes its steps to the console.

A release: set the same version in `package.json`, `static/manifest.json` and `src/background/mcp-client.ts`, then push a tag with that version. The workflow builds the zip, attests it, and creates the release.

## License

MIT
