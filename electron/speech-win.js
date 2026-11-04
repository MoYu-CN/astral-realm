'use strict'

/*
 * Windows 本机语音识别桥。
 *
 * 由一个单独的 Windows PowerShell 进程承载 System.Speech：
 *   - 使用系统已安装的 zh-CN 语音识别器，不需要云端 Key；
 *   - 事件从 C# 线程直接输出 JSON 行，主进程再转发给渲染进程；
 *   - 录音由主进程通过 stdin 的 "stop" 结束，避免浏览器 Web Speech
 *     在 Electron 里常见的 audio-capture 失败。
 *
 * 这一段通过 -EncodedCommand 传给 powershell.exe，不落临时脚本。
 */
const POWERSHELL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
  Add-Type -AssemblyName System.Speech
  $source = @'
using System;
using System.IO;
using System.Speech.Recognition;
using System.Text;
using System.Threading;

public static class AstralSpeechBridge
{
    private static readonly object Sync = new object();
    private static readonly StringBuilder Transcript = new StringBuilder();
    private static string lastPartial = "";

    private static string Escape(string value)
    {
        if (String.IsNullOrEmpty(value)) return "";
        StringBuilder sb = new StringBuilder(value.Length + 8);
        foreach (char ch in value)
        {
            switch (ch)
            {
                case '\\': sb.Append("\\\\"); break;
                case '"': sb.Append("\\\""); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                default:
                    if (ch < 32) sb.Append("\\u").Append(((int)ch).ToString("x4"));
                    else sb.Append(ch);
                    break;
            }
        }
        return sb.ToString();
    }

    private static void Emit(string type, string text, string transcript, string message)
    {
        lock (Sync)
        {
            StringBuilder sb = new StringBuilder();
            sb.Append("{\"type\":\"").Append(Escape(type)).Append("\"");
            if (text != null) sb.Append(",\"text\":\"").Append(Escape(text)).Append("\"");
            if (transcript != null) sb.Append(",\"transcript\":\"").Append(Escape(transcript)).Append("\"");
            if (message != null) sb.Append(",\"message\":\"").Append(Escape(message)).Append("\"");
            sb.Append("}");
            Console.Out.WriteLine(sb.ToString());
            Console.Out.Flush();
        }
    }

    public static int Run(string language, string wavPath)
    {
        try
        {
            Console.OutputEncoding = new UTF8Encoding(false);
            RecognizerInfo info = null;
            RecognizerInfo fallback = null;
            foreach (RecognizerInfo candidate in SpeechRecognitionEngine.InstalledRecognizers())
            {
                if (fallback == null) fallback = candidate;
                if (!String.IsNullOrEmpty(language) &&
                    String.Equals(candidate.Culture.Name, language, StringComparison.OrdinalIgnoreCase))
                {
                    info = candidate;
                    break;
                }
            }
            if (info == null) info = fallback;
            if (info == null)
            {
                Emit("error", null, null, "no-recognizer");
                return 1;
            }

            using (SpeechRecognitionEngine engine = new SpeechRecognitionEngine(info))
            {
                engine.LoadGrammar(new DictationGrammar());
                if (!String.IsNullOrEmpty(wavPath) && File.Exists(wavPath))
                    engine.SetInputToWaveFile(wavPath);
                else
                    engine.SetInputToDefaultAudioDevice();

                engine.SpeechHypothesized += (sender, args) =>
                {
                    lastPartial = args.Result == null ? "" : args.Result.Text;
                    if (!String.IsNullOrEmpty(lastPartial)) Emit("partial", lastPartial, null, null);
                };

                engine.SpeechRecognized += (sender, args) =>
                {
                    string text = args.Result == null ? "" : args.Result.Text;
                    if (String.IsNullOrWhiteSpace(text)) return;
                    string full;
                    lock (Sync)
                    {
                        Transcript.Append(text);
                        full = Transcript.ToString();
                    }
                    Emit("final", text, full, null);
                };

                engine.SpeechRecognitionRejected += (sender, args) => { };
                engine.RecognizeCompleted += (sender, args) =>
                {
                    if (args.Error != null) Emit("error", null, null, "recognize-failed: " + args.Error.Message);
                };

                engine.RecognizeAsync(RecognizeMode.Multiple);
                Emit("ready", null, null, info.Culture.Name);

                string line;
                while ((line = Console.ReadLine()) != null)
                {
                    if (line.Trim().Equals("stop", StringComparison.OrdinalIgnoreCase)) break;
                }

                Thread.Sleep(220);
                try { engine.RecognizeAsyncCancel(); } catch { }
                Thread.Sleep(120);

                string final;
                lock (Sync) { final = Transcript.ToString(); }
                if (String.IsNullOrEmpty(final) && !String.IsNullOrEmpty(lastPartial)) final = lastPartial;
                Emit("done", null, final, null);
            }
            return 0;
        }
        catch (Exception err)
        {
            Emit("error", null, null, "start-failed: " + err.Message);
            return 1;
        }
    }
}
'@
  Add-Type -TypeDefinition $source -ReferencedAssemblies System.Speech
  $code = [AstralSpeechBridge]::Run([string]$env:ASTRAL_SPEECH_LANG, [string]$env:ASTRAL_SPEECH_WAV)
  exit $code
} catch {
  [Console]::Out.WriteLine('{"type":"error","message":"powershell-start-failed"}')
  [Console]::Out.Flush()
  exit 1
}
`

module.exports = { POWERSHELL_SCRIPT }
