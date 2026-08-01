# Third-Party Notices

## OpenConnector runtime

Kun distributes the OpenConnector 1.4.0 local connector runtime as a separate,
checksum-pinned sidecar. It is licensed under the Apache License, Version 2.0.
Its complete license and notices are included in packaged applications at
`open-connector/current/LICENSE.txt` and `open-connector/current/NOTICE.md`.

OpenConnector provider names and APIs are used solely for interoperability;
their trademarks and service marks remain the property of their respective
owners.

## China connector brand icons

Kun bundles local copies of the official site/app icons for identification in
the connector catalog. The assets are loaded from the installation package and
are never fetched by the renderer at runtime.

- Feishu icon: `www.feishu.cn` / `p1-hera.feishucdn.com`
- DingTalk icon: `www.dingtalk.com` / `gw.alicdn.com`
- WeCom icon: `work.weixin.qq.com` / `wwcdn.weixin.qq.com`
- QQ Mail icon: `mail.qq.com` / `res.wx.qq.com`
- NetEase Mail icon: `mail.163.com`

Feishu, DingTalk, WeCom, QQ Mail, NetEase Mail, their names, logos, and related
marks are the property of their respective owners. They are reproduced only to
identify interoperable third-party services; no endorsement or affiliation is
implied.

## agent-skills adapted subagent instructions

Kun includes standalone subagent instructions adapted from the `agents/` and
`skills/` directories of
[addyosmani/agent-skills](https://github.com/addyosmani/agent-skills), source
revision `2fbfa004a0192529bc997d103fc12f19a3804aab`.
The original workflow material has been rewritten as self-contained Kun agent
system prompts; it is not loaded as Skill resources at runtime.

MIT License

Copyright (c) 2025 Addy Osmani

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
