--[[
  ============================================================
  Lime AI Plugin v3.0
  Premium UI built on the original working structure
  ============================================================
]]

local API_BASE_URL = "https://lime-ai-tmy2.onrender.com/api/v1"
local PLUGIN_VERSION = "3.0.0"
local POLL_INTERVAL = 3

local HttpService         = game:GetService("HttpService")
local Selection           = game:GetService("Selection")
local ScriptEditorService = game:GetService("ScriptEditorService")
local TweenService        = game:GetService("TweenService")
local RunService          = game:GetService("RunService")

local pluginState = {
	accessToken    = nil,
	refreshToken   = nil,
	conversationId = nil,
	isStreaming    = false,
}

local jobPollingActive = false
local statusBarLabel   = nil
local scrollFrame      = nil
local sendBtn          = nil
local inputBox         = nil

local LIME      = Color3.fromRGB(134, 239, 94)
local LIME_DARK = Color3.fromRGB(22, 55, 16)
local LIME_MID  = Color3.fromRGB(60, 140, 40)
local BG        = Color3.fromRGB(10, 14, 10)
local SURFACE   = Color3.fromRGB(18, 24, 16)
local SURFACE2  = Color3.fromRGB(26, 36, 22)
local BORDER    = Color3.fromRGB(40, 60, 32)
local TEXT      = Color3.fromRGB(220, 240, 215)
local TEXT_DIM  = Color3.fromRGB(100, 130, 90)
local TEXT_FAINT= Color3.fromRGB(55, 75, 50)
local RED       = Color3.fromRGB(239, 80, 80)
local CODE_BG   = Color3.fromRGB(12, 18, 10)
local CODE_TEXT = Color3.fromRGB(160, 220, 140)

local toolbar = plugin:CreateToolbar("Lime AI")
local toggleBtn = toolbar:CreateButton("Lime AI", "Open Lime AI — AI Coding Assistant for Roblox", "rbxassetid://6031068426")

local widgetInfo = DockWidgetPluginGuiInfo.new(Enum.InitialDockState.Right, true, false, 400, 640, 300, 440)
local widget = plugin:CreateDockWidgetPluginGui("LimeAI_v3", widgetInfo)
widget.Title = "Lime AI"
widget.ZIndexBehavior = Enum.ZIndexBehavior.Sibling

toggleBtn.Click:Connect(function()
	widget.Enabled = not widget.Enabled
	toggleBtn:SetActive(widget.Enabled)
end)

local function makeRequest(method, endpoint, body, useAuth)
	local headers = { ["Content-Type"] = "application/json" }
	if useAuth and pluginState.accessToken then
		headers["Authorization"] = "Bearer " .. pluginState.accessToken
	end
	local ok, response = pcall(function()
		return HttpService:RequestAsync({
			Url = API_BASE_URL .. endpoint, Method = method,
			Headers = headers, Body = body and HttpService:JSONEncode(body) or nil,
		})
	end)
	if not ok then return nil, "Network error: " .. tostring(response) end
	local decoded
	pcall(function() decoded = HttpService:JSONDecode(response.Body) end)
	if not decoded then decoded = { error = response.Body } end
	return decoded, response.StatusCode >= 400 and (decoded.error or "Request failed") or nil
end

local function refreshAccessToken()
	if not pluginState.refreshToken then return false end
	local r = makeRequest("POST", "/auth/refresh", { refreshToken = pluginState.refreshToken }, false)
	if r and r.accessToken then
		pluginState.accessToken = r.accessToken
		pluginState.refreshToken = r.refreshToken
		plugin:SetSetting("refreshToken", r.refreshToken)
		return true
	end
	return false
end

local function apiCall(method, endpoint, body)
	local result, err = makeRequest(method, endpoint, body, true)
	if err and tostring(err):find("401") then
		if refreshAccessToken() then
			result, err = makeRequest(method, endpoint, body, true)
		end
	end
	return result, err
end

local function insertCode(code, scriptType, location)
	local svc = {
		ServerScriptService = game:GetService("ServerScriptService"),
		ReplicatedStorage   = game:GetService("ReplicatedStorage"),
		Workspace           = game:GetService("Workspace"),
		StarterGui          = game:GetService("StarterGui"),
	}
	local parent = svc[location] or game:GetService("ServerScriptService")
	local s
	if scriptType == "LocalScript" then s = Instance.new("LocalScript")
	elseif scriptType == "ModuleScript" then s = Instance.new("ModuleScript")
	else s = Instance.new("Script") end
	s.Source = code; s.Name = "LimeAI_Generated"; s.Parent = parent
	Selection:Set({s})
	pcall(function() ScriptEditorService:OpenScriptDocumentAsync(s) end)
	return s
end

local function processJob(job)
	if not job.code or job.code == "" then return end
	local s = insertCode(job.code, job.scriptType, job.insertLocation)
	s.Name = job.scriptName or "LimeAI_Script"
	task.spawn(function() apiCall("POST", "/jobs/" .. job.id .. "/inserted", {}) end)
	print("[Lime AI] Inserted: " .. s.Name)
	if statusBarLabel then
		statusBarLabel.Text = "✅ Inserted: " .. s.Name
		statusBarLabel.TextColor3 = LIME
		task.delay(3, function()
			if statusBarLabel then
				statusBarLabel.Text = "● Watching for website jobs..."
				statusBarLabel.TextColor3 = TEXT_FAINT
			end
		end)
	end
end

local function pollForJobs()
	if not pluginState.accessToken then return end
	local result = apiCall("GET", "/jobs/pending", nil)
	if not result or not result.jobs then return end
	for _, job in ipairs(result.jobs) do task.spawn(processJob, job) end
end

local function startJobPolling()
	if jobPollingActive then return end
	jobPollingActive = true
	task.spawn(function()
		while jobPollingActive do
			pcall(pollForJobs)
			task.wait(POLL_INTERVAL)
		end
	end)
	print("[Lime AI] Job polling active")
end

local function makeSpinner(parent, size, pos)
	local img = Instance.new("ImageLabel")
	img.Size = size or UDim2.new(0, 28, 0, 28)
	img.Position = pos or UDim2.new(0.5, -14, 0.5, -14)
	img.BackgroundTransparency = 1
	img.Image = "rbxassetid://4965945816"
	img.ImageColor3 = LIME
	img.Parent = parent
	local angle = 0
	local conn = RunService.Heartbeat:Connect(function(dt)
		angle = angle + dt * 200
		img.Rotation = angle
	end)
	return img, conn
end

local msgCount = 0

local function addMessage(role, text)
	if not scrollFrame then return end
	local isUser = role == "user"
	msgCount = msgCount + 1
	local wrapper = Instance.new("Frame")
	wrapper.Name = "Msg_" .. msgCount
	wrapper.Size = UDim2.new(1, 0, 0, 0)
	wrapper.AutomaticSize = Enum.AutomaticSize.Y
	wrapper.BackgroundTransparency = 1
	wrapper.LayoutOrder = msgCount
	wrapper.Parent = scrollFrame

	local wl = Instance.new("UIListLayout")
	wl.FillDirection = Enum.FillDirection.Vertical
	wl.SortOrder = Enum.SortOrder.LayoutOrder
	wl.Padding = UDim.new(0, 4)
	wl.Parent = wrapper

	if not isUser then
		local badge = Instance.new("Frame")
		badge.Size = UDim2.new(0, 58, 0, 18)
		badge.BackgroundColor3 = LIME_DARK
		badge.BorderSizePixel = 0
		badge.LayoutOrder = 1
		badge.Parent = wrapper
		local bc = Instance.new("UICorner"); bc.CornerRadius = UDim.new(0, 4); bc.Parent = badge
		local bl = Instance.new("TextLabel")
		bl.Size = UDim2.new(1, 0, 1, 0); bl.BackgroundTransparency = 1
		bl.Text = "🟢 Lime AI"; bl.TextColor3 = LIME; bl.Font = Enum.Font.GothamBold
		bl.TextSize = 9; bl.TextXAlignment = Enum.TextXAlignment.Center; bl.Parent = badge
	end

	local bubble = Instance.new("Frame")
	bubble.Size = UDim2.new(isUser and 0.88 or 1, 0, 0, 0)
	bubble.AutomaticSize = Enum.AutomaticSize.Y
	bubble.BackgroundColor3 = isUser and LIME_DARK or SURFACE
	bubble.BorderSizePixel = 0
	bubble.LayoutOrder = 2
	bubble.Parent = wrapper
	if isUser then
		bubble.AnchorPoint = Vector2.new(1, 0)
		bubble.Position = UDim2.new(1, 0, 0, 0)
	end
	local bubc = Instance.new("UICorner"); bubc.CornerRadius = UDim.new(0, 12); bubc.Parent = bubble
	if not isUser then
		local bubs = Instance.new("UIStroke"); bubs.Color = BORDER; bubs.Thickness = 1; bubs.Parent = bubble
	end
	local bubp = Instance.new("UIPadding"); bubp.PaddingAll = UDim.new(0, 10); bubp.Parent = bubble
	local tl = Instance.new("TextLabel")
	tl.Size = UDim2.new(1, 0, 0, 0); tl.AutomaticSize = Enum.AutomaticSize.Y
	tl.BackgroundTransparency = 1; tl.Text = text
	tl.TextColor3 = isUser and LIME or TEXT
	tl.Font = Enum.Font.Gotham; tl.TextSize = 13
	tl.TextWrapped = true; tl.TextXAlignment = Enum.TextXAlignment.Left
	tl.LineHeight = 1.45; tl.Parent = bubble

	task.defer(function()
		if scrollFrame and scrollFrame.Parent then
			scrollFrame.CanvasPosition = Vector2.new(0, scrollFrame.AbsoluteCanvasSize.Y)
		end
	end)
	return wrapper
end

local typingMsg = nil
local typingConn = nil

local function showTyping()
	typingMsg = addMessage("assistant", "▪ ▫ ▫")
	local lbl = typingMsg and typingMsg:FindFirstChildWhichIsA("TextLabel", true)
	if lbl then
		local dots = {"▪ ▫ ▫","▫ ▪ ▫","▫ ▫ ▪"}
		local i = 1
		typingConn = RunService.Heartbeat:Connect(function()
			if not typingMsg or not typingMsg.Parent then
				if typingConn then typingConn:Disconnect() end return
			end
			i = i % 3 + 1; lbl.Text = dots[i]
		end)
	end
end

local function hideTyping()
	if typingConn then typingConn:Disconnect(); typingConn = nil end
	if typingMsg and typingMsg.Parent then typingMsg:Destroy() end
	typingMsg = nil
end

local function sendMessage(message)
	if pluginState.isStreaming or message == "" then return end
	pluginState.isStreaming = true
	if inputBox then inputBox.Text = "" end
	if sendBtn then
		sendBtn.Text = "•••"
		sendBtn.BackgroundColor3 = LIME_MID
	end
	addMessage("user", message)
	showTyping()
	task.spawn(function()
		local body = { message = message, stream = false }
		if pluginState.conversationId then body.conversationId = pluginState.conversationId end
		local result, err = apiCall("POST", "/chat", body)
		hideTyping()
		if err or not result then
			addMessage("assistant", "❌ " .. (err or "Something went wrong. Wake the server first!"))
		else
			pluginState.conversationId = result.conversationId
			addMessage("assistant", result.content)
		end
		pluginState.isStreaming = false
		if sendBtn then
			sendBtn.Text = "▶"
			sendBtn.BackgroundColor3 = LIME
		end
	end)
end

local function buildMainUI()
	for _, c in ipairs(widget:GetChildren()) do
		if c:IsA("GuiObject") then c:Destroy() end
	end
	msgCount = 0

	local root = Instance.new("Frame")
	root.Name = "Root"; root.Size = UDim2.new(1, 0, 1, 0)
	root.BackgroundColor3 = BG; root.BorderSizePixel = 0; root.Parent = widget

	local rootList = Instance.new("UIListLayout")
	rootList.FillDirection = Enum.FillDirection.Vertical
	rootList.SortOrder = Enum.SortOrder.LayoutOrder; rootList.Parent = root

	local topBar = Instance.new("Frame")
	topBar.Size = UDim2.new(1, 0, 0, 52)
	topBar.BackgroundColor3 = SURFACE; topBar.BorderSizePixel = 0
	topBar.LayoutOrder = 1; topBar.Parent = root
	local tbs = Instance.new("UIStroke"); tbs.Color = BORDER; tbs.Thickness = 1; tbs.Parent = topBar

	local accentLine = Instance.new("Frame")
	accentLine.Size = UDim2.new(1, 0, 0, 2); accentLine.Position = UDim2.new(0, 0, 0, 0)
	accentLine.BackgroundColor3 = LIME; accentLine.BorderSizePixel = 0; accentLine.Parent = topBar

	local logoPill = Instance.new("Frame")
	logoPill.Size = UDim2.new(0, 130, 0, 32); logoPill.Position = UDim2.new(0, 10, 0.5, -16)
	logoPill.BackgroundColor3 = LIME_DARK; logoPill.BorderSizePixel = 0; logoPill.Parent = topBar
	local lpc = Instance.new("UICorner"); lpc.CornerRadius = UDim.new(0, 8); lpc.Parent = logoPill
	local logoLbl = Instance.new("TextLabel")
	logoLbl.Size = UDim2.new(1, 0, 1, 0); logoLbl.BackgroundTransparency = 1
	logoLbl.Text = "🟢  Lime AI"; logoLbl.TextColor3 = LIME
	logoLbl.Font = Enum.Font.GothamBold; logoLbl.TextSize = 14
	logoLbl.TextXAlignment = Enum.TextXAlignment.Center; logoLbl.Parent = logoPill

	local newBtn = Instance.new("TextButton")
	newBtn.Size = UDim2.new(0, 80, 0, 30); newBtn.Position = UDim2.new(1, -88, 0.5, -15)
	newBtn.BackgroundColor3 = LIME_DARK; newBtn.Text = "＋ New"
	newBtn.TextColor3 = LIME; newBtn.Font = Enum.Font.GothamBold; newBtn.TextSize = 12
	newBtn.BorderSizePixel = 0; newBtn.Parent = topBar
	local nbc = Instance.new("UICorner"); nbc.CornerRadius = UDim.new(0, 8); nbc.Parent = newBtn

	local statusBar = Instance.new("Frame")
	statusBar.Size = UDim2.new(1, 0, 0, 22)
	statusBar.BackgroundColor3 = SURFACE2; statusBar.BorderSizePixel = 0
	statusBar.LayoutOrder = 2; statusBar.Parent = root

	local statusLbl = Instance.new("TextLabel")
	statusLbl.Size = UDim2.new(1, -12, 1, 0); statusLbl.Position = UDim2.new(0, 10, 0, 0)
	statusLbl.BackgroundTransparency = 1; statusLbl.Text = "● Watching for website jobs..."
	statusLbl.TextColor3 = TEXT_FAINT; statusLbl.Font = Enum.Font.Gotham; statusLbl.TextSize = 10
	statusLbl.TextXAlignment = Enum.TextXAlignment.Left; statusLbl.Parent = statusBar
	statusBarLabel = statusLbl

	local msgOuter = Instance.new("Frame")
	msgOuter.Size = UDim2.new(1, 0, 1, -126)
	msgOuter.BackgroundColor3 = BG; msgOuter.BorderSizePixel = 0
	msgOuter.LayoutOrder = 3; msgOuter.Parent = root

	local scroll = Instance.new("ScrollingFrame")
	scroll.Size = UDim2.new(1, 0, 1, 0); scroll.BackgroundTransparency = 1
	scroll.BorderSizePixel = 0; scroll.ScrollBarThickness = 3
	scroll.ScrollBarImageColor3 = LIME_MID
	scroll.CanvasSize = UDim2.new(0, 0, 0, 0); scroll.AutomaticCanvasSize = Enum.AutomaticSize.Y
	scroll.ScrollingDirection = Enum.ScrollingDirection.Y; scroll.Parent = msgOuter
	scrollFrame = scroll

	local msgList = Instance.new("UIListLayout")
	msgList.FillDirection = Enum.FillDirection.Vertical
	msgList.SortOrder = Enum.SortOrder.LayoutOrder; msgList.Padding = UDim.new(0, 10); msgList.Parent = scroll

	local scrollPad = Instance.new("UIPadding")
	scrollPad.PaddingLeft = UDim.new(0, 12); scrollPad.PaddingRight = UDim.new(0, 12)
	scrollPad.PaddingTop = UDim.new(0, 12); scrollPad.PaddingBottom = UDim.new(0, 12)
	scrollPad.Parent = scroll

	local inputArea = Instance.new("Frame")
	inputArea.Size = UDim2.new(1, 0, 0, 52)
	inputArea.BackgroundColor3 = SURFACE; inputArea.BorderSizePixel = 0
	inputArea.LayoutOrder = 4; inputArea.Parent = root
	local ias = Instance.new("UIStroke"); ias.Color = BORDER; ias.Thickness = 1; ias.Parent = inputArea

	local inputWrap = Instance.new("Frame")
	inputWrap.Size = UDim2.new(1, -54, 1, -12); inputWrap.Position = UDim2.new(0, 8, 0, 6)
	inputWrap.BackgroundColor3 = BG; inputWrap.BorderSizePixel = 0; inputWrap.Parent = inputArea
	local iwc = Instance.new("UICorner"); iwc.CornerRadius = UDim.new(0, 10); iwc.Parent = inputWrap
	local iws = Instance.new("UIStroke"); iws.Color = BORDER; iws.Thickness = 1; iws.Parent = inputWrap

	local tb = Instance.new("TextBox")
	tb.Size = UDim2.new(1, 0, 1, 0); tb.BackgroundTransparency = 1
	tb.TextColor3 = TEXT; tb.PlaceholderText = "Ask anything about Roblox..."
	tb.PlaceholderColor3 = TEXT_FAINT; tb.Font = Enum.Font.Gotham; tb.TextSize = 13
	tb.TextWrapped = true; tb.MultiLine = true; tb.ClearTextOnFocus = false
	tb.BorderSizePixel = 0; tb.TextXAlignment = Enum.TextXAlignment.Left
	tb.TextYAlignment = Enum.TextYAlignment.Top; tb.Parent = inputWrap
	local tbp = Instance.new("UIPadding"); tbp.PaddingAll = UDim.new(0, 8); tbp.Parent = tb
	inputBox = tb

	tb.Focused:Connect(function() iws.Color = LIME_MID end)
	tb.FocusLost:Connect(function() iws.Color = BORDER end)

	local sbFrame = Instance.new("Frame")
	sbFrame.Size = UDim2.new(0, 38, 0, 38); sbFrame.Position = UDim2.new(1, -46, 0.5, -19)
	sbFrame.BackgroundColor3 = LIME; sbFrame.BorderSizePixel = 0; sbFrame.Parent = inputArea
	local sbc = Instance.new("UICorner"); sbc.CornerRadius = UDim.new(0, 10); sbc.Parent = sbFrame
	sendBtn = sbFrame

	local sbLbl = Instance.new("TextLabel")
	sbLbl.Size = UDim2.new(1, 0, 1, 0); sbLbl.BackgroundTransparency = 1
	sbLbl.Text = "▶"; sbLbl.TextColor3 = LIME_DARK; sbLbl.Font = Enum.Font.GothamBold
	sbLbl.TextSize = 15; sbLbl.TextXAlignment = Enum.TextXAlignment.Center; sbLbl.Parent = sbFrame

	local sbClick = Instance.new("TextButton")
	sbClick.Size = UDim2.new(1, 0, 1, 0); sbClick.BackgroundTransparency = 1
	sbClick.Text = ""; sbClick.Parent = sbFrame

	sbClick.MouseButton1Click:Connect(function()
		local msg = tb.Text:gsub("^%s+", ""):gsub("%s+$", "")
		if msg ~= "" then sendMessage(msg) end
	end)

	tb.FocusLost:Connect(function(enter)
		if enter then
			local msg = tb.Text:gsub("^%s+", ""):gsub("%s+$", "")
			if msg ~= "" then sendMessage(msg) end
		end
	end)

	sbClick.MouseEnter:Connect(function()
		TweenService:Create(sbFrame, TweenInfo.new(0.15), {BackgroundColor3 = LIME_MID}):Play()
	end)
	sbClick.MouseLeave:Connect(function()
		TweenService:Create(sbFrame, TweenInfo.new(0.15), {BackgroundColor3 = LIME}):Play()
	end)

	newBtn.MouseButton1Click:Connect(function()
		pluginState.conversationId = nil
		for _, c in ipairs(scroll:GetChildren()) do
			if not c:IsA("UIListLayout") and not c:IsA("UIPadding") then c:Destroy() end
		end
		msgCount = 0
		addMessage("assistant", "✨ Fresh start! What are we building today?")
	end)

	addMessage("assistant", "👋 Welcome to Lime AI!\n\nI can help you:\n• Write and fix Roblox scripts\n• Generate complete game systems\n• Debug and refactor code\n• Answer any Roblox question\n\nTip: Visit lime-ai-eight.vercel.app and use Build in Studio — code appears here automatically!")

	startJobPolling()
end

local function buildLoginUI()
	for _, c in ipairs(widget:GetChildren()) do
		if c:IsA("GuiObject") then c:Destroy() end
	end

	local root = Instance.new("Frame")
	root.Name = "LoginRoot"; root.Size = UDim2.new(1, 0, 1, 0)
	root.BackgroundColor3 = BG; root.BorderSizePixel = 0; root.Parent = widget

	local top = Instance.new("Frame")
	top.Size = UDim2.new(1, 0, 0, 3); top.BackgroundColor3 = LIME
	top.BorderSizePixel = 0; top.Parent = root

	local card = Instance.new("Frame")
	card.Size = UDim2.new(0.88, 0, 0, 0); card.AutomaticSize = Enum.AutomaticSize.Y
	card.AnchorPoint = Vector2.new(0.5, 0); card.Position = UDim2.new(0.5, 0, 0, 50)
	card.BackgroundColor3 = SURFACE; card.BorderSizePixel = 0; card.Parent = root
	local cc = Instance.new("UICorner"); cc.CornerRadius = UDim.new(0, 16); cc.Parent = card
	local cs = Instance.new("UIStroke"); cs.Color = BORDER; cs.Thickness = 1; cs.Parent = card

	local cardList = Instance.new("UIListLayout")
	cardList.FillDirection = Enum.FillDirection.Vertical
	cardList.SortOrder = Enum.SortOrder.LayoutOrder
	cardList.HorizontalAlignment = Enum.HorizontalAlignment.Center
	cardList.Padding = UDim.new(0, 12); cardList.Parent = card

	local cardPad = Instance.new("UIPadding")
	cardPad.PaddingLeft = UDim.new(0, 22); cardPad.PaddingRight = UDim.new(0, 22)
	cardPad.PaddingTop = UDim.new(0, 24); cardPad.PaddingBottom = UDim.new(0, 28)
	cardPad.Parent = card

	local logoCircle = Instance.new("Frame")
	logoCircle.Size = UDim2.new(0, 64, 0, 64); logoCircle.BackgroundColor3 = LIME_DARK
	logoCircle.BorderSizePixel = 0; logoCircle.LayoutOrder = 1; logoCircle.Parent = card
	local lcc = Instance.new("UICorner"); lcc.CornerRadius = UDim.new(0, 16); lcc.Parent = logoCircle
	local logoEmoji = Instance.new("TextLabel")
	logoEmoji.Size = UDim2.new(1, 0, 1, 0); logoEmoji.BackgroundTransparency = 1
	logoEmoji.Text = "🌿"; logoEmoji.TextColor3 = LIME; logoEmoji.Font = Enum.Font.GothamBold
	logoEmoji.TextSize = 28; logoEmoji.TextXAlignment = Enum.TextXAlignment.Center
	logoEmoji.Parent = logoCircle

	local titleLbl = Instance.new("TextLabel")
	titleLbl.Size = UDim2.new(1, 0, 0, 28); titleLbl.BackgroundTransparency = 1
	titleLbl.Text = "Lime AI"; titleLbl.TextColor3 = LIME
	titleLbl.Font = Enum.Font.GothamBold; titleLbl.TextSize = 22
	titleLbl.TextXAlignment = Enum.TextXAlignment.Center
	titleLbl.LayoutOrder = 2; titleLbl.Parent = card

	local subLbl = Instance.new("TextLabel")
	subLbl.Size = UDim2.new(1, 0, 0, 18); subLbl.BackgroundTransparency = 1
	subLbl.Text = "AI coding assistant for Roblox Studio"
	subLbl.TextColor3 = TEXT_DIM; subLbl.Font = Enum.Font.Gotham; subLbl.TextSize = 11
	subLbl.TextXAlignment = Enum.TextXAlignment.Center
	subLbl.LayoutOrder = 3; subLbl.Parent = card

	local divider = Instance.new("Frame")
	divider.Size = UDim2.new(1, 0, 0, 1); divider.BackgroundColor3 = BORDER
	divider.BorderSizePixel = 0; divider.LayoutOrder = 4; divider.Parent = card

	local function makeField(placeholder, order)
		local wrap = Instance.new("Frame")
		wrap.Size = UDim2.new(1, 0, 0, 52); wrap.BackgroundColor3 = SURFACE2
		wrap.BorderSizePixel = 0; wrap.LayoutOrder = order; wrap.Parent = card
		local wc = Instance.new("UICorner"); wc.CornerRadius = UDim.new(0, 10); wc.Parent = wrap
		local ws = Instance.new("UIStroke"); ws.Color = BORDER; ws.Thickness = 1; ws.Parent = wrap
		local lbl = Instance.new("TextLabel")
		lbl.Size = UDim2.new(1, -20, 0, 14); lbl.Position = UDim2.new(0, 12, 0, 8)
		lbl.BackgroundTransparency = 1; lbl.Text = placeholder:upper()
		lbl.TextColor3 = TEXT_FAINT; lbl.Font = Enum.Font.GothamBold; lbl.TextSize = 9
		lbl.TextXAlignment = Enum.TextXAlignment.Left; lbl.Parent = wrap
		local box = Instance.new("TextBox")
		box.Size = UDim2.new(1, -24, 0, 24); box.Position = UDim2.new(0, 12, 0, 24)
		box.BackgroundTransparency = 1; box.TextColor3 = TEXT
		box.PlaceholderText = placeholder; box.PlaceholderColor3 = TEXT_FAINT
		box.Font = Enum.Font.Gotham; box.TextSize = 13; box.ClearTextOnFocus = false
		box.BorderSizePixel = 0; box.TextXAlignment = Enum.TextXAlignment.Left; box.Parent = wrap
		box.Focused:Connect(function() ws.Color = LIME_MID end)
		box.FocusLost:Connect(function() ws.Color = BORDER end)
		return box, wrap
	end

	local emailBox, emailWrap = makeField("Email address", 5)
	local passBox, passWrap = makeField("Password", 6)

	local statusLbl = Instance.new("TextLabel")
	statusLbl.Size = UDim2.new(1, 0, 0, 14); statusLbl.BackgroundTransparency = 1
	statusLbl.Text = ""; statusLbl.TextColor3 = RED; statusLbl.Font = Enum.Font.Gotham
	statusLbl.TextSize = 11; statusLbl.TextXAlignment = Enum.TextXAlignment.Center
	statusLbl.LayoutOrder = 7; statusLbl.Parent = card

	local loginBtn = Instance.new("TextButton")
	loginBtn.Size = UDim2.new(1, 0, 0, 42); loginBtn.BackgroundColor3 = LIME
	loginBtn.Text = "Sign In →"; loginBtn.TextColor3 = LIME_DARK
	loginBtn.Font = Enum.Font.GothamBold; loginBtn.TextSize = 14
	loginBtn.BorderSizePixel = 0; loginBtn.LayoutOrder = 8; loginBtn.Parent = card
	local lbc = Instance.new("UICorner"); lbc.CornerRadius = UDim.new(0, 10); lbc.Parent = loginBtn

	local spinWrap = Instance.new("Frame")
	spinWrap.Size = UDim2.new(0, 36, 0, 36); spinWrap.BackgroundTransparency = 1
	spinWrap.LayoutOrder = 9; spinWrap.Visible = false; spinWrap.Parent = card

	local signupLbl = Instance.new("TextLabel")
	signupLbl.Size = UDim2.new(1, 0, 0, 14); signupLbl.BackgroundTransparency = 1
	signupLbl.Text = "Sign up at lime-ai-eight.vercel.app"
	signupLbl.TextColor3 = TEXT_FAINT; signupLbl.Font = Enum.Font.Gotham; signupLbl.TextSize = 10
	signupLbl.TextXAlignment = Enum.TextXAlignment.Center
	signupLbl.LayoutOrder = 10; signupLbl.Parent = card

	loginBtn.MouseEnter:Connect(function()
		TweenService:Create(loginBtn, TweenInfo.new(0.15), {BackgroundColor3 = LIME_MID}):Play()
	end)
	loginBtn.MouseLeave:Connect(function()
		TweenService:Create(loginBtn, TweenInfo.new(0.15), {BackgroundColor3 = LIME}):Play()
	end)

	local spinConn = nil

	local function doLogin()
		local email = emailBox.Text:gsub("%s", "")
		local pass = passBox.Text
		if email == "" or pass == "" then
			statusLbl.Text = "⚠ Please fill in all fields"
			return
		end
		loginBtn.Visible = false; spinWrap.Visible = true
		statusLbl.Text = "Connecting..."; statusLbl.TextColor3 = TEXT_DIM
		local _, conn = makeSpinner(spinWrap, UDim2.new(0, 32, 0, 32), UDim2.new(0, 2, 0, 2))
		spinConn = conn
		task.spawn(function()
			local result, err = makeRequest("POST", "/auth/login", {email = email, password = pass}, false)
			if spinConn then spinConn:Disconnect() end
			spinWrap.Visible = false; loginBtn.Visible = true
			if result and result.accessToken then
				pluginState.accessToken = result.accessToken
				pluginState.refreshToken = result.refreshToken
				plugin:SetSetting("refreshToken", result.refreshToken)
				buildMainUI()
			else
				statusLbl.Text = "❌ " .. (err or "Login failed. Wake server first!")
				statusLbl.TextColor3 = RED
			end
		end)
	end

	loginBtn.MouseButton1Click:Connect(doLogin)
	passBox.FocusLost:Connect(function(enter) if enter then doLogin() end end)
end

local function init()
	local loadBg = Instance.new("Frame")
	loadBg.Size = UDim2.new(1, 0, 1, 0); loadBg.BackgroundColor3 = BG
	loadBg.BorderSizePixel = 0; loadBg.ZIndex = 100; loadBg.Parent = widget

	local _, loadConn = makeSpinner(loadBg, UDim2.new(0, 36, 0, 36), UDim2.new(0.5, -18, 0.5, -28))
	local loadLbl = Instance.new("TextLabel")
	loadLbl.Size = UDim2.new(1, 0, 0, 20); loadLbl.Position = UDim2.new(0, 0, 0.5, 20)
	loadLbl.BackgroundTransparency = 1; loadLbl.Text = "Loading Lime AI..."
	loadLbl.TextColor3 = TEXT_DIM; loadLbl.Font = Enum.Font.Gotham; loadLbl.TextSize = 12
	loadLbl.TextXAlignment = Enum.TextXAlignment.Center; loadLbl.ZIndex = 101; loadLbl.Parent = loadBg

	local function done(buildFn)
		task.delay(0.4, function()
			if loadConn then loadConn:Disconnect() end
			loadBg:Destroy()
			buildFn()
		end)
	end

	local saved = plugin:GetSetting("refreshToken")
	if saved and saved ~= "" then
		pluginState.refreshToken = saved
		task.spawn(function()
			local r = makeRequest("POST", "/auth/refresh", {refreshToken = saved}, false)
			if r and r.accessToken then
				pluginState.accessToken = r.accessToken
				pluginState.refreshToken = r.refreshToken
				plugin:SetSetting("refreshToken", r.refreshToken)
				done(buildMainUI)
			else
				done(buildLoginUI)
			end
		end)
	else
		done(buildLoginUI)
	end
end

widget:GetPropertyChangedSignal("Enabled"):Connect(function()
	if widget.Enabled and #widget:GetChildren() == 0 then init() end
end)

init()

print("[Lime AI] v" .. PLUGIN_VERSION .. " ready!")
