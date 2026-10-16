/// Rounds are kept as one JSON file each (data/rounds/<timestamp>.json): small, easy to back up, no database server.
module Oracle.Store

open System
open System.IO
open System.Text.Json

type Round =
    { Timestamp: int64            // milliseconds since epoch
      Root: string                // hex
      Tx: string                  // transaction hash of the commitment ("" if it was not sent)
      Tickers: string[]
      Values: decimal[]
      Evidence: string }            // JSON: per ticker what each source answered, who was dropped, the day of a daily close (null in older rounds)

let private options = JsonSerializerOptions(WriteIndented = true)

let private dir (data: string) =
    let d = Path.Combine(data, "rounds")
    Directory.CreateDirectory d |> ignore
    d

let save (data: string) (r: Round) =
    let path = Path.Combine(dir data, sprintf "%013d.json" r.Timestamp)
    File.WriteAllText(path + ".tmp", JsonSerializer.Serialize(r, options))
    File.Move(path + ".tmp", path, true)

let all (data: string) : Round list =
    Directory.GetFiles(dir data, "*.json")
    |> Array.sort
    |> Array.map (fun f -> JsonSerializer.Deserialize<Round>(File.ReadAllText f, options))
    |> Array.toList

let latest data = all data |> List.tryLast

/// The round with the given root, or the newest round at or before the timestamp.
let find data (root: string option) (timestamp: int64 option) =
    let rounds = all data
    match root, timestamp with
    | Some r, _ -> rounds |> List.tryFind (fun x -> x.Root = r)
    | None, Some t -> rounds |> List.filter (fun x -> x.Timestamp <= t) |> List.tryLast
    | None, None -> rounds |> List.tryLast

/// The slot of a moment (ms since epoch): the start of its interval (on the hour for 60 minutes). Rounds are stamped with
/// their slot, so a market's close (FixedPayout V1) is a known timestamp.
let slotOf (intervalMinutes: int) (ms: int64) =
    let len = int64 intervalMinutes * 60000L
    (ms / len) * len

/// Whether the slot already has a round: one round per slot (two roots with the same timestamp could settle a market
/// either way).
let hasSlot (data: string) (slot: int64) = File.Exists(Path.Combine(dir data, sprintf "%013d.json" slot))

/// How long to wait (ms) before the next attempt: after a round, until 20 s into the next slot; after a failure, 5 minutes,
/// but never past that point, so a retry stays in its slot and a late one starts the next slot.
let nextWait (intervalMinutes: int) (nowMs: int64) (ok: bool) =
    let toNext = slotOf intervalMinutes nowMs + int64 intervalMinutes * 60000L + 20000L - nowMs
    max 1000L (if ok then toNext else min 300000L toNext)
