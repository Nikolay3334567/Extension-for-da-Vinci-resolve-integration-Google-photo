--[[
Cloud Pool — bridge script for DaVinci Resolve (works in the free edition too).

Run it from  Workspace ▸ Scripts ▸ Cloud Pool.  It starts the Cloud Pool app (if it is not
running yet) and then executes the app's "send to Media Pool / timeline" requests inside Resolve.
Blackmagic reserves external scripting and Workflow Integration plugins for DaVinci Resolve
Studio, but scripts started from the Scripts menu run in every edition.

Communication happens through a small JSON mailbox in the app's data folder:
  request.json  (app → Resolve)   response.json (Resolve → app)
  status.json   (Resolve → app)   app.json      (app → Resolve, heartbeat)
Only a fixed set of commands is executed; request content is never evaluated as code.
The script stops by itself a minute after the Cloud Pool window is closed.
]]

local BRIDGE_VERSION = 1
local POLL = 0.2
local APP_STALE_SECONDS = 75
local LAUNCH_WAIT_SECONDS = 40
local STILL_SECONDS = 5

local resolve = Resolve()
local sep = package.config:sub(1, 1)
local isWindows = sep == "\\"
local osName = (jit and jit.os) or (isWindows and "Windows" or "Unknown")

local function sleep(seconds)
  if bmd and bmd.wait then
    bmd.wait(seconds)
  elseif not isWindows then
    os.execute("sleep " .. tostring(seconds))
  else
    local t = os.clock() + seconds
    while os.clock() < t do end
  end
end

-- ── Minimal JSON (decode + encode) ────────────────────────────────────────────

local json = { null = setmetatable({}, { __tostring = function() return "null" end }) }

local function utf8char(c)
  if c < 0x80 then return string.char(c) end
  if c < 0x800 then return string.char(0xC0 + math.floor(c / 0x40), 0x80 + c % 0x40) end
  if c < 0x10000 then
    return string.char(0xE0 + math.floor(c / 0x1000), 0x80 + math.floor(c / 0x40) % 0x40, 0x80 + c % 0x40)
  end
  return string.char(0xF0 + math.floor(c / 0x40000), 0x80 + math.floor(c / 0x1000) % 0x40,
    0x80 + math.floor(c / 0x40) % 0x40, 0x80 + c % 0x40)
end

do
  local escapes = { b = "\b", f = "\f", n = "\n", r = "\r", t = "\t", ['"'] = '"', ["\\"] = "\\", ["/"] = "/" }

  local function skip(s, i)
    local _, e = s:find("^[ \n\r\t]*", i)
    return e + 1
  end

  local parse

  local function parseString(s, i)
    local out = {}
    i = i + 1
    while true do
      local c = s:sub(i, i)
      if c == "" then error("JSON: unterminated string") end
      if c == '"' then return table.concat(out), i + 1 end
      if c == "\\" then
        local n = s:sub(i + 1, i + 1)
        if escapes[n] then
          out[#out + 1] = escapes[n]
          i = i + 2
        elseif n == "u" then
          local code = tonumber(s:sub(i + 2, i + 5), 16) or 63
          i = i + 6
          if code >= 0xD800 and code <= 0xDBFF and s:sub(i, i + 1) == "\\u" then
            local lo = tonumber(s:sub(i + 2, i + 5), 16)
            if lo and lo >= 0xDC00 and lo <= 0xDFFF then
              code = 0x10000 + (code - 0xD800) * 0x400 + (lo - 0xDC00)
              i = i + 6
            end
          end
          out[#out + 1] = utf8char(code)
        else
          error("JSON: bad escape")
        end
      else
        local a, b = s:find('^[^"\\]+', i)
        out[#out + 1] = s:sub(a, b)
        i = b + 1
      end
    end
  end

  parse = function(s, i)
    i = skip(s, i)
    local c = s:sub(i, i)
    if c == "{" then
      local obj = {}
      i = skip(s, i + 1)
      if s:sub(i, i) == "}" then return obj, i + 1 end
      while true do
        local key
        key, i = parseString(s, skip(s, i))
        i = skip(s, i)
        if s:sub(i, i) ~= ":" then error("JSON: expected ':'") end
        local value
        value, i = parse(s, i + 1)
        obj[key] = value
        i = skip(s, i)
        local d = s:sub(i, i)
        if d == "}" then return obj, i + 1 end
        if d ~= "," then error("JSON: expected ',' or '}'") end
        i = i + 1
      end
    elseif c == "[" then
      local arr = {}
      i = skip(s, i + 1)
      if s:sub(i, i) == "]" then return arr, i + 1 end
      while true do
        local value
        value, i = parse(s, i)
        arr[#arr + 1] = value
        i = skip(s, i)
        local d = s:sub(i, i)
        if d == "]" then return arr, i + 1 end
        if d ~= "," then error("JSON: expected ',' or ']'") end
        i = i + 1
      end
    elseif c == '"' then
      return parseString(s, i)
    elseif s:sub(i, i + 3) == "true" then
      return true, i + 4
    elseif s:sub(i, i + 4) == "false" then
      return false, i + 5
    elseif s:sub(i, i + 3) == "null" then
      return nil, i + 4
    else
      local a, b = s:find("^-?%d+%.?%d*[eE]?[-+]?%d*", i)
      if not a then error("JSON: unexpected character at " .. i) end
      return tonumber(s:sub(a, b)), b + 1
    end
  end

  function json.decode(s)
    local value = parse(s, 1)
    return value
  end

  local function encodeString(s)
    return '"' .. (s:gsub('[%c"\\]', function(ch)
      local map = { ['"'] = '\\"', ["\\"] = "\\\\", ["\n"] = "\\n", ["\r"] = "\\r", ["\t"] = "\\t" }
      return map[ch] or string.format("\\u%04x", ch:byte())
    end)) .. '"'
  end

  function json.encode(v)
    local t = type(v)
    if v == nil or v == json.null then return "null" end
    if t == "boolean" then return tostring(v) end
    if t == "number" then
      if v ~= v or v == math.huge or v == -math.huge then return "null" end
      if math.floor(v) == v and math.abs(v) < 1e15 then return string.format("%d", v) end
      return string.format("%.14g", v)
    end
    if t == "string" then return encodeString(v) end
    if t == "table" then
      local n = #v
      if n > 0 then
        local parts = {}
        for i = 1, n do parts[i] = json.encode(v[i]) end
        return "[" .. table.concat(parts, ",") .. "]"
      end
      local parts = {}
      for k, val in pairs(v) do
        local vt = type(val)
        if vt ~= "function" and vt ~= "userdata" then
          parts[#parts + 1] = encodeString(tostring(k)) .. ":" .. json.encode(val)
        end
      end
      return "{" .. table.concat(parts, ",") .. "}"
    end
    return "null"
  end
end

-- ── Mailbox folder (must match the app's data folder) ─────────────────────────

local function dataRoot()
  if isWindows then return (os.getenv("APPDATA") or "") .. "\\Cloud Pool for Resolve" end
  local home = os.getenv("HOME") or ""
  if osName == "OSX" then return home .. "/Library/Application Support/Cloud Pool for Resolve" end
  local xdg = os.getenv("XDG_CONFIG_HOME")
  if xdg and xdg ~= "" then return xdg .. "/Cloud Pool for Resolve" end
  if io.open("/Library/Application Support", "r") then
    return home .. "/Library/Application Support/Cloud Pool for Resolve"
  end
  return home .. "/.config/Cloud Pool for Resolve"
end

local mailbox = dataRoot() .. sep .. "resolve-bridge"
local function mpath(name) return mailbox .. sep .. name end

local function readJson(path)
  local f = io.open(path, "rb")
  if not f then return nil end
  local content = f:read("*a")
  f:close()
  if not content or content == "" then return nil end
  local ok, value = pcall(json.decode, content)
  if ok then return value end
  return nil
end

local function writeJson(path, value)
  local tmp = path .. ".tmp"
  local f = io.open(tmp, "wb")
  if not f then return false end
  f:write(json.encode(value))
  f:close()
  os.remove(path) -- os.rename cannot replace an existing file on Windows
  return os.rename(tmp, path) and true or false
end

-- ── Resolve helpers ───────────────────────────────────────────────────────────

local function list(t)
  local out = {}
  if type(t) ~= "table" then return out end
  for _, v in ipairs(t) do out[#out + 1] = v end
  if #out == 0 then
    local keys = {}
    for k in pairs(t) do keys[#keys + 1] = k end
    table.sort(keys, function(a, b) return tostring(a) < tostring(b) end)
    for _, k in ipairs(keys) do out[#out + 1] = t[k] end
  end
  return out
end

local function try(fn, fallback)
  local ok, value = pcall(fn)
  if ok and value ~= nil then return value end
  return fallback
end

local function normPath(p)
  p = tostring(p or ""):gsub("[\\/]+", "/")
  if isWindows or osName == "OSX" then p = p:lower() end
  return p
end

local function parseRate(v)
  local n = tonumber((tostring(v or ""):gsub(",", ".")))
  if n and n > 0 then return n end
  return 24
end

local function isDropTc(tc) return tostring(tc or ""):match("[;,]%d+$") ~= nil end

local function tcToFrames(tc, fps)
  local hh, mm, ss, ff = tostring(tc):match("^(%d+):(%d+):(%d+)[:;.,](%d+)$")
  if not hh then return 0 end
  hh, mm, ss, ff = tonumber(hh), tonumber(mm), tonumber(ss), tonumber(ff)
  local base = math.floor(fps + 0.5)
  local frames = (hh * 3600 + mm * 60 + ss) * base + ff
  if isDropTc(tc) and math.abs(fps - base) > 0.001 then
    local totalMinutes = hh * 60 + mm
    local drop = math.floor(fps * 0.066666 + 0.5)
    frames = frames - drop * (totalMinutes - math.floor(totalMinutes / 10))
  end
  return frames
end

local function framesToTc(frames, fps, dropFrame)
  local base = math.floor(fps + 0.5)
  frames = math.max(0, math.floor(frames + 0.5))
  local df = dropFrame and math.abs(fps - base) > 0.001
  if df then
    local drop = math.floor(fps * 0.066666 + 0.5)
    local per10 = math.floor(fps * 600 + 0.5)
    local perMin = base * 60 - drop
    local tens = math.floor(frames / per10)
    local rem = frames % per10
    local extra = 0
    if rem > drop then extra = drop * math.floor((rem - drop) / perMin) end
    frames = frames + drop * 9 * tens + extra
  end
  local ff = frames % base
  local total = math.floor(frames / base)
  return string.format("%02d:%02d:%02d%s%02d", math.floor(total / 3600), math.floor(total / 60) % 60, total % 60, df and ";" or ":", ff)
end

local function currentProject()
  local pm = resolve:GetProjectManager()
  local project = pm and pm:GetCurrentProject()
  if not project then error("Open a project in DaVinci Resolve first") end
  return project
end

local function findOrCreateBin(mediaPool, name)
  local root = mediaPool:GetRootFolder()
  if not name or name == "" then return root end
  for _, folder in ipairs(list(root:GetSubFolderList())) do
    if try(function() return folder:GetName() end) == name then return folder end
  end
  local created = mediaPool:AddSubFolder(root, name)
  if not created then error('Could not create the "' .. name .. '" bin') end
  return created
end

local function importClips(mediaPool, bin, clips)
  local existing = {}
  for _, item in ipairs(list(bin:GetClipList())) do
    existing[#existing + 1] = { item = item, path = normPath(try(function() return item:GetClipProperty("File Path") end, "")) }
  end
  local results, missing = {}, {}
  for i, clip in ipairs(clips) do
    local want = normPath(clip.path)
    for _, e in ipairs(existing) do
      if e.path == want then results[i] = { item = e.item, reused = true } break end
    end
    if not results[i] then missing[#missing + 1] = i end
  end
  if #missing > 0 then
    local previous = try(function() return mediaPool:GetCurrentFolder() end)
    mediaPool:SetCurrentFolder(bin)
    local paths = {}
    for _, i in ipairs(missing) do paths[#paths + 1] = clips[i].path end
    local ok, imported = pcall(function() return list(mediaPool:ImportMedia(paths)) end)
    if previous then pcall(function() mediaPool:SetCurrentFolder(previous) end) end
    if not ok then error(imported) end
    local fresh = {}
    for _, item in ipairs(imported) do
      fresh[#fresh + 1] = { item = item, path = normPath(try(function() return item:GetClipProperty("File Path") end, "")) }
    end
    for _, i in ipairs(missing) do
      local want = normPath(clips[i].path)
      local match
      for _, f in ipairs(fresh) do
        if f.path == want then match = f break end
      end
      if not match and #missing == 1 and #fresh == 1 then match = fresh[1] end
      if match then
        results[i] = { item = match.item, reused = false }
        local c = clips[i]
        if c.comment then pcall(function() match.item:SetMetadata("Comments", c.comment) end) end
        if c.key then pcall(function() match.item:SetThirdPartyMetadata("Cloud Pool Source", c.key) end) end
      end
    end
  end
  for i, clip in ipairs(clips) do
    if not results[i] then error('DaVinci Resolve could not import "' .. tostring(clip.name or clip.path) .. '"') end
  end
  return results
end

local function clipInfoOf(item, clip)
  local props = try(function() return item:GetClipProperty() end, {})
  local fps = parseRate(props["FPS"] or clip.fps or 30)
  local frames = tonumber(props["Frames"]) or 0
  local still = clip.kind == "photo" or tostring(props["Type"] or ""):lower():find("still") ~= nil
  local audioCh = tonumber(props["Audio Ch"]) or 0
  local hasAudio = (not still) and (audioCh > 0 or (props["Audio Codec"] ~= nil and props["Audio Codec"] ~= ""))
  return { fps = fps, frames = frames, still = still, hasAudio = hasAudio }
end

local function sourceRange(info, clip)
  if info.still then return nil end
  local s = 0
  local e = info.frames
  if clip.inSec then s = math.floor(clip.inSec * info.fps + 1e-6) end
  if clip.outSec then e = math.ceil(clip.outSec * info.fps - 1e-6) end
  if info.frames > 0 then
    s = math.min(math.max(0, s), math.max(0, info.frames - 1))
    e = math.min(math.max(s + 1, e), info.frames)
  else
    e = math.max(s + 1, e)
  end
  return { start = s, finish = e }
end

local function trackItems(timeline, kind, index)
  local out = {}
  for _, it in ipairs(list(try(function() return timeline:GetItemListInTrack(kind, index) end, {}))) do
    out[#out + 1] = { s = tonumber(try(function() return it:GetStart() end, 0)) or 0, e = tonumber(try(function() return it:GetEnd() end, 0)) or 0 }
  end
  return out
end

local function overlaps(items, s, e)
  for _, it in ipairs(items) do
    if it.s < e and it.e > s then return true end
  end
  return false
end

local function addTrack(timeline, kind)
  if kind == "audio" then
    if try(function() return timeline:AddTrack("audio", { audioType = "stereo" }) end, false) then return true end
    if try(function() return timeline:AddTrack("audio", "stereo") end, false) then return true end
  end
  return try(function() return timeline:AddTrack(kind) end, false) and true or false
end

local function ensureAudioTracks(timeline, count)
  local a = tonumber(try(function() return timeline:GetTrackCount("audio") end, 0)) or 0
  while a < count do
    if not addTrack(timeline, "audio") then return end
    a = tonumber(timeline:GetTrackCount("audio")) or a + 1
  end
end

local function findFreeTrack(timeline, s, e, needAudio)
  local vCount = tonumber(try(function() return timeline:GetTrackCount("video") end, 1)) or 1
  local aCount = tonumber(try(function() return timeline:GetTrackCount("audio") end, 0)) or 0
  for t = 1, vCount do
    local free = not try(function() return timeline:GetIsTrackLocked("video", t) end, false)
      and not overlaps(trackItems(timeline, "video", t), s, e)
    if free and needAudio then
      if t <= aCount then
        free = not try(function() return timeline:GetIsTrackLocked("audio", t) end, false)
          and not overlaps(trackItems(timeline, "audio", t), s, e)
      else
        ensureAudioTracks(timeline, t)
      end
    end
    if free then return t end
  end
  if not addTrack(timeline, "video") then error("Could not add a video track") end
  local t = tonumber(timeline:GetTrackCount("video"))
  if needAudio then ensureAudioTracks(timeline, t) end
  return t
end

local function defaultTimelineName(project)
  local base = "Cloud Pool " .. os.date("%Y-%m-%d %H.%M")
  local names = {}
  local n = tonumber(try(function() return project:GetTimelineCount() end, 0)) or 0
  for i = 1, n do
    names[try(function() return project:GetTimelineByIndex(i):GetName() end, "")] = true
  end
  if not names[base] then return base end
  for i = 2, 999 do
    local candidate = base .. " (" .. i .. ")"
    if not names[candidate] then return candidate end
  end
  return base .. " " .. os.time()
end

local function importAndPlace(req)
  local clips = req.clips or {}
  if #clips == 0 then return { imported = 0, reused = 0, placed = 0 } end
  local action = req.action or "append"
  local project = currentProject()
  local mediaPool = project:GetMediaPool()
  local bin = findOrCreateBin(mediaPool, req.binName or "Google Photos")
  local items = importClips(mediaPool, bin, clips)
  local summary = { imported = 0, reused = 0, placed = 0, createdTimeline = false }
  for _, r in ipairs(items) do
    if r.reused then summary.reused = summary.reused + 1 else summary.imported = summary.imported + 1 end
  end
  if action == "import" then return summary end

  local timeline = try(function() return project:GetCurrentTimeline() end)
  if not timeline or action == "newTimeline" then
    timeline = mediaPool:CreateEmptyTimeline(defaultTimelineName(project))
    if not timeline then error("Could not create a timeline") end
    pcall(function() project:SetCurrentTimeline(timeline) end)
    summary.createdTimeline = true
  end
  summary.timeline = try(function() return timeline:GetName() end, "")

  if action == "playhead" and not summary.createdTimeline then
    local tlFps = parseRate(try(function() return timeline:GetSetting("timelineFrameRate") end, 24))
    local startFrame = tonumber(try(function() return timeline:GetStartFrame() end, 0)) or 0
    local startTc = try(function() return timeline:GetStartTimecode() end, "00:00:00:00")
    local currentTc = try(function() return timeline:GetCurrentTimecode() end, startTc)
    local dropFrame = isDropTc(currentTc) or isDropTc(startTc)
    local cursor = startFrame + (tcToFrames(currentTc, tlFps) - tcToFrames(startTc, tlFps))
    for i, clip in ipairs(clips) do
      local info = clipInfoOf(items[i].item, clip)
      local range = sourceRange(info, clip)
      local length
      if info.still then
        length = math.floor(STILL_SECONDS * tlFps + 0.5)
        range = { start = 0, finish = length }
      else
        length = math.max(1, math.floor((range.finish - range.start) / info.fps * tlFps + 0.5))
      end
      local track = findFreeTrack(timeline, cursor, cursor + length, info.hasAudio)
      local placed = list(mediaPool:AppendToTimeline({ {
        mediaPoolItem = items[i].item, startFrame = range.start, endFrame = range.finish,
        recordFrame = cursor, trackIndex = track,
      } }))
      if #placed == 0 then error('Resolve refused to place "' .. tostring(clip.name) .. '" (is the track locked?)') end
      summary.placed = summary.placed + 1
      local finish = tonumber(try(function() return placed[1]:GetEnd() end, cursor + length)) or (cursor + length)
      if finish > cursor then cursor = finish else cursor = cursor + length end
    end
    pcall(function()
      timeline:SetCurrentTimecode(framesToTc(tcToFrames(startTc, tlFps) + (cursor - startFrame), tlFps, dropFrame))
    end)
  else
    for i, clip in ipairs(clips) do
      local info = clipInfoOf(items[i].item, clip)
      local range = sourceRange(info, clip)
      local entry = items[i].item
      if range and (clip.inSec or clip.outSec) then
        entry = { mediaPoolItem = items[i].item, startFrame = range.start, endFrame = range.finish }
      end
      local placed = list(mediaPool:AppendToTimeline({ entry }))
      if #placed == 0 then error('Resolve refused to append "' .. tostring(clip.name) .. '" (is the track locked?)') end
      summary.placed = summary.placed + 1
    end
  end
  if req.switchToEdit then pcall(function() resolve:OpenPage("edit") end) end
  return summary
end

-- ── Status + launcher ─────────────────────────────────────────────────────────

local function writeStatus()
  local status = {
    v = BRIDGE_VERSION,
    heartbeat = os.time(),
    product = tostring(try(function() return resolve:GetProductName() end, "DaVinci Resolve")),
    version = tostring(try(function() return resolve:GetVersionString() end, "")),
  }
  local ok, project = pcall(function()
    local pm = resolve:GetProjectManager()
    return pm and pm:GetCurrentProject()
  end)
  if ok and project then
    status.project = try(function() return project:GetName() end)
    local timeline = try(function() return project:GetCurrentTimeline() end)
    if timeline then
      status.timeline = try(function() return timeline:GetName() end)
      status.fps = parseRate(try(function() return timeline:GetSetting("timelineFrameRate") end, 24))
    end
  end
  writeJson(mpath("status.json"), status)
end

local function appAlive()
  local app = readJson(mpath("app.json"))
  return app and tonumber(app.heartbeat) and (os.time() - tonumber(app.heartbeat)) < 20
end

local function quote(s) return '"' .. tostring(s):gsub('"', '\\"') .. '"' end

local function launchApp()
  local launch = readJson(mpath("launch.json"))
  if not launch or not launch.exe then return false end
  local args = {}
  for _, a in ipairs(launch.args or {}) do args[#args + 1] = quote(a) end
  local cmd
  if isWindows then
    cmd = 'start "" ' .. quote(launch.exe) .. " " .. table.concat(args, " ")
  else
    cmd = quote(launch.exe) .. " " .. table.concat(args, " ") .. " >/dev/null 2>&1 &"
  end
  os.execute(cmd)
  return true
end

-- ── Main loop ─────────────────────────────────────────────────────────────────

if not io.open(mpath("app.json"), "r") and not io.open(mpath("launch.json"), "r") then
  print("[Cloud Pool] The Cloud Pool app has not been started on this computer yet.")
  print("[Cloud Pool] Start it once (see README), then run this script again.")
  print("[Cloud Pool] Expected data folder: " .. mailbox)
  return
end

if not appAlive() then
  print("[Cloud Pool] Starting the Cloud Pool app…")
  launchApp()
  local waited = 0
  while not appAlive() and waited < LAUNCH_WAIT_SECONDS do
    writeStatus()
    sleep(1)
    waited = waited + 1
  end
  if not appAlive() then
    print("[Cloud Pool] The app did not start. Open Cloud Pool manually, then run this script again.")
    return
  end
end

print("[Cloud Pool] Connected. Keep this script running while you work (it stops when Cloud Pool is closed).")
local lastSeq = (readJson(mpath("request.json")) or {}).seq or 0
local lastStatus = 0
local lastAlive = os.time()

while true do
  local now = os.time()
  if appAlive() then lastAlive = now end
  if now - lastAlive > APP_STALE_SECONDS then break end
  if now - lastStatus >= 1 then
    pcall(writeStatus)
    lastStatus = now
  end
  local req = readJson(mpath("request.json"))
  if req and req.seq and req.seq ~= lastSeq then
    lastSeq = req.seq
    local response
    if req.action == "stop" then
      writeJson(mpath("response.json"), { seq = req.seq, ok = true, result = { stopped = true } })
      break
    elseif req.action == "ping" then
      response = { seq = req.seq, ok = true, result = { pong = true, version = BRIDGE_VERSION } }
    elseif req.action == "place" then
      local ok, result = pcall(importAndPlace, req.payload or {})
      if ok then
        response = { seq = req.seq, ok = true, result = result }
      else
        response = { seq = req.seq, ok = false, error = tostring(result):gsub("^.-:%d+: ", "") }
      end
    else
      response = { seq = req.seq, ok = false, error = "Unknown command" }
    end
    writeJson(mpath("response.json"), response)
    pcall(writeStatus)
  end
  sleep(POLL)
end

os.remove(mpath("status.json"))
print("[Cloud Pool] Bridge stopped.")
