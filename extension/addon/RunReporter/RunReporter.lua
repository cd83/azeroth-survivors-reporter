-- Run Reporter: keeps each finished run's numbers in RunReporterDB. The game writes saved
-- variables to the browser's storage when you leave a run (Main Menu or Again), and the
-- Azeroth Survivors Reporter extension reads them from there.
--
-- The game's addon lines (CHAT_MSG_ADDON, prefix "AZS...") are kept raw: the extension parses
-- them, so a new field in a game update reaches Discord without a new addon.

RUNREPORTER_VERSION = 1;
RUNREPORTER_MAX_RUNS = 30;

-- The latest line of each kind, by prefix.
local lines = {};
-- The run recorded this session, refreshed with the last lines at logout.
local current = nil;

-- The lines kept with a run: AZSEND is its summary, the rest give it context.
local KEPT = {
	zone = "AZSZONE",
	run = "AZSRUN",
	meter = "AZSMETER",
	heal = "AZSHEAL",
	bossmeter = "AZSBOSSDMG",
	party = "AZSPARTY",
	taken = "AZSTAKEN",
	spells = "AZSSPELLS",
	bosses = "AZSBOSSES",
};

local function RunReporter_Init()
	if ( type(RunReporterDB) ~= "table" ) then
		RunReporterDB = {};
	end
	if ( type(RunReporterDB.runs) ~= "table" ) then
		RunReporterDB.runs = {};
	end
	RunReporterDB.version = RUNREPORTER_VERSION;
end

local function RunReporter_Fill(run)
	for key, prefix in pairs(KEPT) do
		if ( lines[prefix] ) then
			run[key] = lines[prefix];
		end
	end
end

local function RunReporter_Record(msg)
	if ( not string.find(msg, "result=", 1, 1) ) then
		return;
	end
	RunReporter_Init();
	local runs = RunReporterDB.runs;
	local n = table.getn(runs);
	-- The end line can come more than once for the same run.
	if ( n > 0 and runs[n].summary == msg ) then
		current = runs[n];
	else
		current = { summary = msg };
		if ( time ) then
			current.ts = time();
		end
		table.insert(runs, current);
	end
	RunReporter_Fill(current);
	while ( table.getn(RunReporterDB.runs) > RUNREPORTER_MAX_RUNS ) do
		table.remove(RunReporterDB.runs, 1);
	end
end

local frame = CreateFrame("Frame", "RunReporterFrame");
frame:RegisterEvent("VARIABLES_LOADED");
frame:RegisterEvent("CHAT_MSG_ADDON");
frame:RegisterEvent("PLAYER_LOGOUT");
frame:SetScript("OnEvent", function()
	if ( event == "VARIABLES_LOADED" ) then
		RunReporter_Init();
	elseif ( event == "CHAT_MSG_ADDON" ) then
		if ( type(arg1) ~= "string" or string.sub(arg1, 1, 3) ~= "AZS" ) then
			return;
		end
		lines[arg1] = arg2;
		if ( arg1 == "AZSEND" ) then
			RunReporter_Record(arg2);
		end
	elseif ( event == "PLAYER_LOGOUT" ) then
		-- The meters can update after the end line; take their last word.
		if ( current ) then
			RunReporter_Fill(current);
		end
	end
end);
