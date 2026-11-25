# Chrome Web Store listing

The extension is not in the Chrome Web Store yet; it is installed from the release zip. This is what to enter in the developer dashboard when it goes there. Images: `store/images/` (made by `node store/shots.ts`, see the end).

## Store listing

**Name:** Gemini MCP Bridge (from `static/_locales/*/messages.json`)

**Summary** (132 characters at most; from the manifest's description):

- en: Lets Gemini on the web use MCP tools on your own computer: your shell, your files, and any local MCP server.
- ko: 웹의 Gemini가 내 컴퓨터의 MCP 도구(셸, 파일, 로컬 MCP 서버)를 쓰게 해 줍니다.

**Category:** Developer Tools

**Language:** English (with a Korean translation of the extension)

**Description (en):**

```
Give Gemini on the web the tools of your own computer.

Gemini MCP Bridge connects Gemini on the web (gemini.google.com, Gemini Enterprise, and other chat pages) to MCP servers running on your computer. You chat with Gemini as usual. When Gemini needs your computer, it calls a tool: list a folder, read a file, run a command, or anything a local MCP server offers. The result goes back to Gemini by itself.

HOW IT WORKS
• Click the extension's icon in the tab where you chat: it works in that tab only, until you click again.
• The first message of a conversation carries instructions and the list of your tools; on the page they fold into a small chip.
• Gemini answers with a tool call. A card under it shows the tool and its arguments.
• Press Run, and the call goes to the MCP server on your computer. The result is sent back to Gemini, which continues.
• A line by the extension's button says where each message is: being written, waiting for your Run, running, sending the results, done.
• On other chat pages, the extension learns the page from one test message you send, and you can point out a part it got wrong.

YOU STAY IN CONTROL
• Every call waits for your Run, unless you allowed that tool to run by itself.
• Calls in old conversations never run: only replies written while you watch.
• After 20 automatic rounds the extension pauses and asks.
• The extension reaches only 127.0.0.1 and localhost.

WHAT YOU NEED
The matching local server, gemini-mcp-bridge-server (free, open source, Node.js): run "npx gemini-mcp-bridge-server" and enter the address and token it prints in the extension's options. It offers shell and file tools and passes through any MCP servers you list (Playwright, databases, and more). Any other MCP server that speaks Streamable HTTP on localhost works too.

PRIVACY
The extension sends nothing to its developer or anyone else. Tool results become part of your Gemini conversation, which Google handles under its own terms.

Open source (MIT): https://github.com/somebodil/gemini-mcp-bridge
This extension is not made by or affiliated with Google.
```

**Description (ko):**

```
웹의 Gemini에게 내 컴퓨터의 도구를 줍니다.

Gemini MCP Bridge는 웹의 Gemini(gemini.google.com, Gemini Enterprise, 다른 채팅 페이지)를 내 컴퓨터에서 도는 MCP 서버와 이어 줍니다. 평소처럼 Gemini와 대화하면, Gemini가 컴퓨터가 필요할 때 도구를 부릅니다: 폴더 보기, 파일 읽기, 명령 실행, 그리고 로컬 MCP 서버가 주는 모든 것. 결과는 저절로 Gemini에게 돌아갑니다.

동작 방식
• 채팅하는 탭에서 확장 아이콘을 누르세요. 다시 누를 때까지 그 탭에서만 동작합니다.
• 대화의 첫 메시지에 지침과 도구 목록이 함께 가고, 페이지에서는 작은 칩으로 접힙니다.
• Gemini가 도구 호출로 답하면, 그 아래 카드에 도구와 인자가 보입니다.
• 실행을 누르면 호출이 내 컴퓨터의 MCP 서버로 가고, 결과가 Gemini에게 돌아가 대화가 이어집니다.
• 확장 버튼 옆의 한 줄이 메시지마다 어디쯤인지 알려 줍니다: 답을 쓰는 중, 실행을 기다리는 중, 실행 중, 결과를 보내는 중, 끝.
• 다른 채팅 페이지에서는 내가 보내는 시험 메시지 하나로 페이지를 학습하고, 잘못 배운 부분은 직접 골라 줄 수 있습니다.

내가 정합니다
• 스스로 실행하게 허용한 도구가 아니면, 모든 호출은 실행을 누를 때까지 기다립니다.
• 지난 대화의 호출은 실행하지 않습니다. 보는 동안 쓰인 답변만 다룹니다.
• 자동으로 20번 주고받으면 멈추고 묻습니다.
• 확장은 127.0.0.1과 localhost에만 연결합니다.

필요한 것
짝이 되는 로컬 서버 gemini-mcp-bridge-server (무료, 오픈 소스, Node.js): "npx gemini-mcp-bridge-server"를 실행하고, 보여 주는 주소와 토큰을 확장 설정에 넣으세요. 셸과 파일 도구가 있고, 적어 둔 MCP 서버(Playwright, 데이터베이스 등)를 그대로 연결합니다. localhost에서 Streamable HTTP로 도는 다른 MCP 서버도 됩니다.

개인정보
확장은 개발자나 다른 누구에게도 아무것도 보내지 않습니다. 도구 결과는 Gemini 대화의 일부가 되고, Google이 자기 약관에 따라 다룹니다.

오픈 소스 (MIT): https://github.com/somebodil/gemini-mcp-bridge
이 확장은 Google이 만들거나 Google과 관련된 것이 아닙니다.
```

## Privacy practices

**Single purpose:** Let Gemini on the web (in the tabs where the user turns the extension on) call tools of MCP servers that run on the user's own computer, and return the results into the conversation.

**Permission justifications:**

- `storage`: keeps the user's settings (MCP server addresses and tokens, the choice for each tool), per conversation a hash of the tool list already sent, and, for chat pages the user asked the extension to learn, CSS selectors to find their input box, buttons and messages again.
- Host permissions `http://127.0.0.1/*`, `http://localhost/*`: the extension sends the tool calls to MCP servers on the user's own computer, at the addresses the user enters. No other host.
- `activeTab` and `scripting`: when the user clicks the extension's icon in a tab, the page script goes into that tab only. It reads the replies to find tool calls, shows the approval cards, and types the results into the input box. No site is reached without that click; there are no content scripts declared for any site.

**Remote code:** No. All code is in the package.

**Data usage** (what the form asks): the extension handles *website content* (Gemini's replies and the text it types into Gemini) on the user's device only. It is not sold, not transferred to third parties, not used for anything but the single purpose, and not used for creditworthiness or lending. Check the three certifications.

**Privacy policy URL:** https://github.com/somebodil/gemini-mcp-bridge/blob/main/PRIVACY.md

## Images

- Store icon 128×128: `static/icons/128.png`
- Screenshots 1280×800: `store/images/screenshot-*.png`
- Small promo tile 440×280: `store/images/promo-small.png`
