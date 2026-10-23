-- Lua twin of test/support/fake-resolve.js: a tiny in-memory DaVinci Resolve used to run the
-- real "Cloud Pool.lua" bridge script under LuaJIT in the test suite.
-- Usage (see test/unit/lua-bridge.test.js):
--   FAKE_MEDIA = { ["/m/a.mp4"] = { fps = 30, frames = 300, audio = true }, ... }
--   FAKE_STATE = "/path/state.json"      -- written after every mutation
--   dofile("test/support/fake_resolve.lua"); dofile("plugin/resolve/Cloud Pool.lua")

local ffi = require("ffi")
ffi.cdef("int usleep(unsigned int usec);")
bmd = { wait = function(s) ffi.C.usleep(math.floor(s * 1000000)) end }

local function tcToFrames(tc, fps)
  local hh, mm, ss, ff = tostring(tc):match("^(%d+):(%d+):(%d+)[:;](%d+)$")
  return ((tonumber(hh) * 60 + tonumber(mm)) * 60 + tonumber(ss)) * math.floor(fps + 0.5) + tonumber(ff)
end

local function framesToTc(frames, fps)
  local base = math.floor(fps + 0.5)
  local total = math.floor(frames / base)
  return string.format("%02d:%02d:%02d:%02d", math.floor(total / 3600), math.floor(total / 60) % 60, total % 60, frames % base)
end

local state = { timelines = {}, current = nil, bins = {}, imports = 0 }

local function dump()
  if not FAKE_STATE then return end
  local parts = {}
  for _, t in ipairs(state.timelines) do
    local tracks = {}
    for kind, lanes in pairs(t.tracks) do
      local laneParts = {}
      for i, lane in ipairs(lanes) do
        local items = {}
        for _, it in ipairs(lane) do
          items[#items + 1] = string.format('{"start":%d,"end":%d,"path":"%s"}', it.start, it["end"], it.item.path)
        end
        laneParts[i] = "[" .. table.concat(items, ",") .. "]"
      end
      tracks[#tracks + 1] = string.format('"%s":[%s]', kind, table.concat(laneParts, ","))
    end
    parts[#parts + 1] = string.format('{"name":"%s","playhead":%d,"startFrame":%d,"current":%s,"tracks":{%s}}',
      t.name, t.playhead, t.startFrame, tostring(state.current == t), table.concat(tracks, ","))
  end
  local bins = {}
  for name, folder in pairs(state.bins) do
    local clips = {}
    for _, c in ipairs(folder.clips) do
      clips[#clips + 1] = string.format('{"path":"%s","comment":"%s"}', c.path, c.metadata.Comments or "")
    end
    bins[#bins + 1] = string.format('"%s":[%s]', name, table.concat(clips, ","))
  end
  local f = io.open(FAKE_STATE .. ".tmp", "w")
  f:write(string.format('{"imports":%d,"timelines":[%s],"bins":{%s}}', state.imports, table.concat(parts, ","), table.concat(bins, ",")))
  f:close()
  os.rename(FAKE_STATE .. ".tmp", FAKE_STATE)
end

local Item = {}
Item.__index = Item
function Item:GetName() return self.path:match("[^/\\]+$") end
function Item:GetClipProperty(key)
  local m = self.media
  local props = {
    ["File Path"] = self.path,
    FPS = tostring(m.fps or 0),
    Frames = tostring(m.frames or 0),
    Type = m.still and "Still" or (m.audio and "Video + Audio" or "Video"),
    ["Audio Ch"] = m.audio and "2" or "0",
    ["Audio Codec"] = m.audio and "AAC" or "",
  }
  if key then return props[key] end
  return props
end
function Item:SetMetadata(k, v) self.metadata[k] = v return true end
function Item:SetThirdPartyMetadata(k, v) return true end

local Folder = {}
Folder.__index = Folder
local function newFolder(name) return setmetatable({ name = name, clips = {}, subs = {} }, Folder) end
function Folder:GetName() return self.name end
function Folder:GetClipList() local out = {} for i, c in ipairs(self.clips) do out[i] = c end return out end
function Folder:GetSubFolderList() local out = {} for i, c in ipairs(self.subs) do out[i] = c end return out end

local TItem = {}
TItem.__index = TItem
function TItem:GetStart() return self.start end
function TItem:GetEnd() return self["end"] end

local Timeline = {}
Timeline.__index = Timeline
local function newTimeline(name, fps)
  local t = setmetatable({ name = name, fps = fps or 24, startTc = "01:00:00:00", tracks = { video = { {} }, audio = { {} } }, locked = {} }, Timeline)
  t.startFrame = tcToFrames(t.startTc, t.fps)
  t.playhead = t.startFrame
  return t
end
function Timeline:GetName() return self.name end
function Timeline:GetSetting(key) if key == "timelineFrameRate" then return tostring(self.fps) end return "" end
function Timeline:GetStartFrame() return self.startFrame end
function Timeline:GetStartTimecode() return self.startTc end
function Timeline:GetCurrentTimecode() return framesToTc(self.playhead, self.fps) end
function Timeline:SetCurrentTimecode(tc) self.playhead = tcToFrames(tc, self.fps) dump() return true end
function Timeline:GetTrackCount(kind) return #(self.tracks[kind] or {}) end
function Timeline:AddTrack(kind) table.insert(self.tracks[kind], {}) return true end
function Timeline:GetItemListInTrack(kind, i) local out = {} for k, v in ipairs(self.tracks[kind][i] or {}) do out[k] = v end return out end
function Timeline:GetIsTrackLocked(kind, i) return self.locked[kind .. i] == true end
function Timeline:GetEndFrame()
  local e = self.startFrame
  for _, lanes in pairs(self.tracks) do for _, lane in ipairs(lanes) do for _, it in ipairs(lane) do if it["end"] > e then e = it["end"] end end end end
  return e
end
function Timeline:_place(info)
  local isInfo = getmetatable(info) ~= Item
  local item = isInfo and info.mediaPoolItem or info
  local m = item.media
  local s = (isInfo and info.startFrame) or 0
  local e = (isInfo and info.endFrame) or (m.still and 5 * self.fps or m.frames)
  local length
  if m.still then length = e - s else length = math.floor((e - s) / m.fps * self.fps + 0.5) end
  local track = (isInfo and info.trackIndex) or 1
  local start = (isInfo and info.recordFrame) or self:GetEndFrame()
  local finish = start + length
  local lanes = { { "video", true }, { "audio", m.audio and not m.still } }
  for _, l in ipairs(lanes) do
    if l[2] then
      local lane = self.tracks[l[1]][track]
      if not lane or self.locked[l[1] .. track] then return nil end
      for _, it in ipairs(lane) do if it.start < finish and it["end"] > start then return nil end end
    end
  end
  local placed
  for _, l in ipairs(lanes) do
    if l[2] then
      local it = setmetatable({ item = item, start = start, ["end"] = finish }, TItem)
      table.insert(self.tracks[l[1]][track], it)
      if l[1] == "video" then placed = it end
    end
  end
  return placed
end

local root = newFolder("Master")
local current = root
local pool = {}
function pool:GetRootFolder() return root end
function pool:AddSubFolder(parent, name) local f = newFolder(name) table.insert(parent.subs, f) state.bins[name] = f return f end
function pool:GetCurrentFolder() return current end
function pool:SetCurrentFolder(f) current = f return true end
function pool:ImportMedia(paths)
  local out = {}
  for _, p in ipairs(paths) do
    local media = FAKE_MEDIA[p]
    if media then
      local it = setmetatable({ path = p, media = media, metadata = {} }, Item)
      table.insert(current.clips, it)
      table.insert(out, 1, it) -- reversed order on purpose
    end
  end
  state.imports = state.imports + 1
  dump()
  return out
end
function pool:CreateEmptyTimeline(name)
  local t = newTimeline(name, FAKE_TIMELINE_FPS)
  table.insert(state.timelines, t)
  dump()
  return t
end
function pool:AppendToTimeline(list)
  local out = {}
  local t = state.current
  if not t then return out end
  for _, info in ipairs(list) do
    local placed = t:_place(info)
    if placed then out[#out + 1] = placed end
  end
  dump()
  return out
end

local project = {}
function project:GetName() return "Lua Project" end
function project:GetMediaPool() return pool end
function project:GetCurrentTimeline() return state.current end
function project:SetCurrentTimeline(t) state.current = t dump() return true end
function project:GetTimelineCount() return #state.timelines end
function project:GetTimelineByIndex(i) return state.timelines[i] end

if FAKE_EXISTING_TIMELINE then
  local t = newTimeline("Existing", FAKE_TIMELINE_FPS)
  table.insert(state.timelines, t)
  state.current = t
  t.playhead = t.startFrame + (FAKE_PLAYHEAD or 0)
  for _, blocked in ipairs(FAKE_BLOCKED or {}) do
    table.insert(t.tracks.video[1], setmetatable({ item = { path = "existing" }, start = t.startFrame + blocked[1], ["end"] = t.startFrame + blocked[2] }, TItem))
  end
end

local fakeResolve = {}
function fakeResolve:GetProjectManager() return { GetCurrentProject = function() return project end } end
function fakeResolve:GetProductName() return "DaVinci Resolve" end
function fakeResolve:GetVersionString() return "21.1.0.14" end
function fakeResolve:OpenPage() return true end

function Resolve() return fakeResolve end
dump()
