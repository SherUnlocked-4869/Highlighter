# Third-party notices

## Index-Translate (bilibili)

`main/services/translation-proxy-service.js` contains a rewritten, in-process
implementation of the local OpenAI-compatible relay that ships with
[bilibili/Index-Translate](https://github.com/bilibili/Index-Translate)
(`inference/llm/call_api.py`, `run_proxy_server`), commit
`9aff74ca50c60873916f99269b10cd0d79237b4a`.

That project is licensed under the Apache License 2.0; the full text is in
`LICENSE-Index-Translate.txt` next to this file. The relay implementation here is
a derivative work and is provided under the same licence terms for the derived
portions.

The Index-Translate *model* and its public API are operated by Bilibili and are
not distributed with Highlighter. Text translated through the built-in cloud
endpoint is sent to `index-translate.bilibili.com`; point the "upstream API
address" setting at a local deployment to keep it on the machine.
