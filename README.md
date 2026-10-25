# Claude Code Read Aloud

A Claude Code mod that reads Claude's final answer of each turn aloud, on Windows. It also speaks an alert when Claude needs you: "Claude needs your permission", or "Claude has a question for you" followed by the question itself. Speech is generated on your own machine with [Piper](https://github.com/rhasspy/piper) neural voices, and nothing you hear is sent to any online service. Without Piper it falls back to the built-in Windows voice.

Before speaking, it strips what sounds bad or shouldn't be said: code blocks, links, file paths, markdown, and anything that looks like an API key or token. Long answers are cut at a sentence end (3,000 characters at most), and speaking starts after the first chunk is ready, so long answers don't make you wait.

## Install

At the prompt of a terminal session:

```
/plugin install read-aloud --marketplace honcoops/claude-code-read-aloud
```

From a shell:

```
claude plugin install read-aloud --marketplace honcoops/claude-code-read-aloud
```

Answer `y` to add the marketplace, then pick a scope. The mod is active right away.

## Better voices (optional)

Out of the box you get the built-in Windows voice. For a more natural one, install Piper and a voice model once. In PowerShell:

```powershell
$root = "$env:USERPROFILE\.claude\read-aloud-piper"
New-Item -ItemType Directory -Force "$root\voices" | Out-Null
Invoke-WebRequest https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip -OutFile "$root\piper.zip"
Expand-Archive "$root\piper.zip" $root -Force; Remove-Item "$root\piper.zip"
$base = "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium"
Invoke-WebRequest "$base/en_US-lessac-medium.onnx" -OutFile "$root\voices\en_US-lessac-medium.onnx"
Invoke-WebRequest "$base/en_US-lessac-medium.onnx.json" -OutFile "$root\voices\en_US-lessac-medium.onnx.json"
```

That downloads about 65 MB. More voices are at [rhasspy/piper-voices](https://huggingface.co/rhasspy/piper-voices): put each `.onnx` and `.onnx.json` pair in the `voices` folder. To keep Piper somewhere else, set the `READ_ALOUD_PIPER_DIR` environment variable to that folder.

## Commands

| Command | What it does |
| --- | --- |
| `/speak` | Turn read-aloud on or off |
| `/speak stop` | Silence what is playing now |
| `/speak replay` | Repeat the last thing spoken |
| `/speak selected` | Read the text you highlighted with the mouse (fullscreen mode only) |
| `/speak rate <-10..10>` | Set the speed; 0 is normal, the default is 3 |
| `/speak voice [name]` | List installed Piper voices, or switch to one |

Sending a new prompt silences the previous answer. Permission alerts never interrupt speech that is already playing, and bursts of requests give one alert.

## Notes

- Windows only: speech is played through PowerShell.
- The rate and voice you choose are remembered across sessions.
- MIT licensed.
