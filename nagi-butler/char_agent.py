"""NagiBridge Char Agent — char 大脑跑在 float 端的 AI 玩家

复用 NagiBridge tool_agent.py 的全部工具执行与循环逻辑，只做两处替换：
  1. 输入源：不再是命令行 input()，而是监听游戏内聊天（NagiBridge Channel 9000 POST）
  2. 大脑：不再是写死的 SYSTEM_PROMPT + 直连 LLM，而是调 float 端的思考接口
     （float 用 generateChatCompletion 生成，char 带原版人设/记忆/预设）

用法（在管家同一台电脑上，另开一个窗口）：
    python char_agent.py --port 7842 --brain http://localhost:3000/api/stardew/think

环境变量（替代参数）：
    NAGI_GAME_PORT, NAGI_BRAIN_URL
"""

import argparse
import json
import os
import subprocess
import threading
import time
import queue
from http.server import HTTPServer, BaseHTTPRequestHandler

import requests

parser = argparse.ArgumentParser(description="NagiBridge Char Agent (float-brained)")
parser.add_argument("--port", type=int, default=int(os.environ.get("NAGI_GAME_PORT", 7842)),
                    help="NagiBridge mod 端口（host=7842 / farmhand=7843）")
parser.add_argument("--brain", default=os.environ.get("NAGI_BRAIN_URL", "http://localhost:7869"),
                    help="管家地址（think 请求经管家转发给 float 浏览器）")
parser.add_argument("--listen", type=int, default=int(os.environ.get("NAGI_AGENT_LISTEN_PORT", 9100)),
                    help="本 agent 监听游戏聊天的端口（NagiBridge ChannelServerUrl 要指向这里）")
parser.add_argument("--max-turns", type=int, default=10, help="每个任务最多工具轮数")
parser.add_argument("--char-name", default=os.environ.get("NAGI_CHAR_NAME", "Nagi"),
                    help="char 在游戏聊天框的显示名")
args = parser.parse_args()

GAME_URL = f"http://localhost:{args.port}"
BRAIN_URL = args.brain.rstrip("/")
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

# 游戏内说话（走 NagiBridge chat/push，和管家送回复同一条路）
def push_to_game(text, sender=None):
    try:
        r = requests.post(f"{GAME_URL}/chat/push",
                          json={"sender": sender or args.char_name, "message": text}, timeout=10)
        return r.json()
    except Exception as e:
        return {"error": str(e)}

# ── 工具定义（原样来自 NagiBridge tool_agent.py，不改） ──

TOOLS = [
    {"name": "get_state", "description": "Get current game state: player position, health, stamina, time, location, inventory, active menu/event", "parameters": {"type": "object", "properties": {}, "required": []}},
    {"name": "get_surroundings", "description": "Scan surrounding tiles for objects, NPCs, monsters, crops. Returns tiles with passability, objects, terrain, crops.", "parameters": {"type": "object", "properties": {"radius": {"type": "integer", "description": "Scan radius (default 10)"}}, "required": []}},
    {"name": "warp", "description": "Teleport to a location. Common: Farm, Town, Beach, Mountain, Forest, Mine, BusStop, Desert", "parameters": {"type": "object", "properties": {"location": {"type": "string"}, "x": {"type": "integer"}, "y": {"type": "integer"}}, "required": ["location"]}},
    {"name": "move_to", "description": "Pathfind and walk to a tile position", "parameters": {"type": "object", "properties": {"x": {"type": "integer"}, "y": {"type": "integer"}}, "required": ["x", "y"]}},
    {"name": "use_tool", "description": "Swing a tool (Axe, Pickaxe, Hoe, Watering Can, etc.) or 'current'", "parameters": {"type": "object", "properties": {"name": {"type": "string", "default": "current"}}, "required": []}},
    {"name": "select_item", "description": "Select an inventory item by name (tool, seed, crop, etc.)", "parameters": {"type": "object", "properties": {"name": {"type": "string"}}, "required": ["name"]}},
    {"name": "interact", "description": "Interact with the object/NPC in front of the player", "parameters": {"type": "object", "properties": {}, "required": []}},
    {"name": "face", "description": "Set facing direction: 0=up, 1=right, 2=down, 3=left", "parameters": {"type": "object", "properties": {"direction": {"type": "integer", "enum": [0, 1, 2, 3]}}, "required": ["direction"]}},
    {"name": "use_item", "description": "Use/place the currently held item (seeds, objects, etc.)", "parameters": {"type": "object", "properties": {}, "required": []}},
    {"name": "press_key", "description": "Simulate a key press. Keys: confirm, cancel, skip, ok, F1-F12", "parameters": {"type": "object", "properties": {"key": {"type": "string"}, "count": {"type": "integer", "default": 1}}, "required": ["key"]}},
    {"name": "run_script", "description": "Run a farming automation script. Available: farm_row, water_crops, harvest, mine_run, chop_trees, clear_area, pet_animals, keg_manager, furnace_manager", "parameters": {"type": "object", "properties": {"script": {"type": "string"}, "args": {"type": "string"}}, "required": ["script"]}},
    {"name": "craft", "description": "Craft an item if you have the recipe and materials", "parameters": {"type": "object", "properties": {"name": {"type": "string"}, "count": {"type": "integer", "default": 1}}, "required": ["name"]}},
    {"name": "sell", "description": "Sell items via the shipping bin. Must be on the Farm.", "parameters": {"type": "object", "properties": {"name": {"type": "string"}}, "required": []}},
    {"name": "sleep", "description": "Go to bed and end the day. Finds your own bed automatically. Check result: state=slept means day ended; state=ready means in bed but day waits for all players -- while ready you MUST NOT move/warp/position/wakeup until date changes, or everyone gets stuck on black screen; already_ready/day_ending = prior sleep still in effect; ok:false already_started/unknown = uncertain, read observed field, do not blindly retry.", "parameters": {"type": "object", "properties": {}, "required": []}},
    {"name": "get_machines", "description": "Scan all machines in current location (kegs, furnaces, etc.) with their status", "parameters": {"type": "object", "properties": {}, "required": []}},
    {"name": "get_animals", "description": "Get all farm animals: pet status, friendship, happiness, product readiness", "parameters": {"type": "object", "properties": {}, "required": []}},
    {"name": "give_item", "description": "Cheat: spawn an item into inventory. Use item ID or (W)ID for weapons.", "parameters": {"type": "object", "properties": {"id": {"type": "string"}, "count": {"type": "integer", "default": 1}}, "required": ["id"]}},
    {"name": "heal", "description": "Cheat: fully restore health and stamina", "parameters": {"type": "object", "properties": {}, "required": []}},
]

# ── 工具执行器（原样来自 NagiBridge tool_agent.py，不改） ──

def game_api(method, endpoint, data=None, params=None):
    try:
        if method == "GET":
            r = requests.get(f"{GAME_URL}{endpoint}", params=params, timeout=10)
        else:
            r = requests.post(f"{GAME_URL}{endpoint}", json=data or {}, timeout=30)
        return r.json()
    except Exception as e:
        return {"error": str(e)}

def execute_tool(name, arguments):
    match name:
        case "get_state":
            return game_api("GET", "/state")
        case "get_surroundings":
            return game_api("GET", "/surroundings", params={"radius": arguments.get("radius", 10)})
        case "warp":
            return game_api("POST", "/warp", arguments)
        case "move_to":
            result = game_api("POST", "/move", arguments)
            time.sleep(2)
            return game_api("GET", "/state")
        case "use_tool":
            return game_api("POST", "/tool", {"name": arguments.get("name", "current")})
        case "select_item":
            return game_api("POST", "/select", {"name": arguments["name"]})
        case "interact":
            return game_api("POST", "/interact")
        case "face":
            return game_api("POST", "/face", {"direction": arguments["direction"]})
        case "use_item":
            return game_api("POST", "/use")
        case "press_key":
            return game_api("POST", "/key", {"key": arguments["key"], "count": arguments.get("count", 1)})
        case "craft":
            return game_api("POST", "/craft", {"name": arguments["name"], "count": arguments.get("count", 1)})
        case "sell":
            data = {}
            if "name" in arguments:
                data["name"] = arguments["name"]
            else:
                data["all"] = True
            return game_api("POST", "/sell", data)
        case "sleep":
            return game_api("POST", "/sleep")
        case "get_machines":
            return game_api("GET", "/machines")
        case "get_animals":
            return game_api("GET", "/animals")
        case "give_item":
            return game_api("POST", "/give", {"id": arguments["id"], "count": arguments.get("count", 1)})
        case "heal":
            return game_api("POST", "/heal")
        case "run_script":
            script = arguments["script"]
            script_path = os.path.join(SCRIPT_DIR, "nagi_scripts", f"{script}.py")
            if not os.path.exists(script_path):
                # 兼容：也找 NagiBridge 原版 scripts 目录
                alt = os.path.join(SCRIPT_DIR, f"{script}.py")
                if os.path.exists(alt):
                    script_path = alt
                else:
                    return {"error": f"Script not found: {script}.py"}
            cmd = f'python "{script_path}" {arguments.get("args", "")} --port {args.port}'
            try:
                result = subprocess.run(cmd, shell=True, capture_output=True, text=True,
                                        timeout=300, env={**os.environ, "PYTHONIOENCODING": "utf-8"})
                return {"stdout": result.stdout[-500:] if result.stdout else "", "returncode": result.returncode}
            except subprocess.TimeoutExpired:
                return {"error": "Script timed out (5min)"}
        case _:
            return {"error": f"Unknown tool: {name}"}

# ── 大脑：经管家转发给 float 浏览器（char 大脑在 float 里） ──

def think(history):
    """把对话历史经管家转发给 float char 大脑，返回 (text, tool_calls)。

    流程：POST 管家 /think → 拿 id → 轮询 GET /think-result?id=xxx → 拿 char 决策
    """
    body = {
        "messages": history,
        "tools": TOOLS,
        "maxTurns": args.max_turns,
    }
    try:
        # 1. 提交思考请求
        r = requests.post(f"{BRAIN_URL}/think", json=body, timeout=30)
        if r.status_code != 200:
            print(f"[brain] HTTP {r.status_code}: {r.text[:200]}")
            return None, []
        req_id = r.json().get("id")
        if not req_id:
            print(f"[brain] 未返回 id: {r.text[:200]}")
            return None, []

        # 2. 轮询结果（管家会阻塞等 float 处理，最多 60s）
        r2 = requests.get(f"{BRAIN_URL}/think-result", params={"id": req_id}, timeout=90)
        if r2.status_code != 200:
            print(f"[brain] result HTTP {r2.status_code}: {r2.text[:200]}")
            return None, []
        data = r2.json()
        if not data.get("ok"):
            print(f"[brain] think 失败: {data.get('error', 'unknown')}")
            return None, []

        text = data.get("text") or ""
        tool_calls = data.get("toolCalls") or []
        out_calls = []
        for tc in tool_calls:
            args_val = tc.get("arguments") or tc.get("input") or {}
            if isinstance(args_val, str):
                try:
                    args_val = json.loads(args_val)
                except Exception:
                    args_val = {}
            out_calls.append({"name": tc.get("name"), "arguments": args_val})
        return text, out_calls
    except Exception as e:
        print(f"[brain] 连接管家/float 失败: {e}")
        return None, []

# ── 输入源：监听游戏聊天（NagiBridge Channel 模式 POST 到这里） ──

msg_queue = queue.Queue()
busy = threading.Event()  # 任务进行中标志：busy 期间收到的消息先排队

class ChannelHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        try:
            body = json.loads(self.rfile.read(length)) if length else {}
        except Exception:
            body = {}
        text = str(body.get("message") or body.get("text") or "").strip()
        sender = str(body.get("sender") or "玩家")
        if text:
            msg_queue.put({"sender": sender, "text": text})
            print(f"[in] ({sender}) {text}")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"ok":true}')

    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"status":"char-agent-listening"}')

    def log_message(self, *a):
        pass

def start_listener():
    server = HTTPServer(("127.0.0.1", args.listen), ChannelHandler)
    print(f"[agent] 监听游戏聊天: http://localhost:{args.listen} (NagiBridge ChannelServerUrl 指向这里)")
    server.serve_forever()

# ── Agent 循环（结构来自 tool_agent.py，输入源换成队列） ──

def run_task(user_text, sender):
    """处理一条玩家指令：char 思考→调工具→看结果→……→最终回复+回写记忆。"""
    print(f"[task] 开始: {user_text}")
    history = [
        {"role": "user", "content": f"({sender} 在游戏里说) {user_text}"},
    ]
    summary_actions = []  # 记录行动，供记忆回写

    for turn in range(args.max_turns):
        text, tool_calls = think(history)
        if text is None and not tool_calls:
            push_to_game("(float 未连接，无法思考)")
            return

        if not tool_calls:
            # char 结束任务，给出最终回复
            if text:
                print(f"[out] {text}")
                push_to_game(text)
                # 回写 float 记忆：完整对话摘要
                try:
                    requests.post(f"{BRAIN_URL}/memory", json={
                        "userText": user_text,
                        "charReply": text,
                        "actions": summary_actions,
                    }, timeout=30)
                except Exception as e:
                    print(f"[mem] 记忆回写失败: {e}")
            return

        # 记录 assistant 轮（含工具调用）
        history.append({"role": "assistant", "content": text or "",
                        "tool_calls": [{"name": tc["name"], "arguments": tc["arguments"]} for tc in tool_calls]})

        for tc in tool_calls:
            name, arguments = tc["name"], tc["arguments"]
            print(f"  [tool] {name}({json.dumps(arguments, ensure_ascii=False)})")
            result = execute_tool(name, arguments)
            result_str = json.dumps(result, ensure_ascii=False)
            if len(result_str) > 2000:
                result_str = result_str[:2000] + "...(truncated)"
            print(f"  [result] {result_str[:200]}")
            history.append({"role": "tool", "name": name, "content": result_str})
            summary_actions.append({"tool": name, "arguments": arguments,
                                    "ok": "error" not in (result if isinstance(result, dict) else {})})

        # 工具轮间隔一小会，别把游戏打爆
        time.sleep(1)

    # 超过轮数上限：强制收尾
    text, _ = think(history + [{"role": "user", "content": "(工具轮数已用完，请直接总结汇报，不要再调工具)"}])
    if text:
        push_to_game(text)

# ── 主循环 ──

def main():
    print(f"NagiBridge Char Agent | game={GAME_URL} brain={BRAIN_URL} char={args.char_name}")
    print(f"游戏内 NagiBridge 需为 Channel 模式，ChannelServerUrl=http://localhost:{args.listen}")
    print("等待玩家在游戏里说话… (Ctrl+C 退出)\n")
    threading.Thread(target=start_listener, daemon=True).start()
    while True:
        try:
            msg = msg_queue.get()  # 阻塞等下一条玩家消息
            run_task(msg["text"], msg["sender"])
        except KeyboardInterrupt:
            print("\n[agent] 退出")
            break
        except Exception as e:
            print(f"[task] 出错: {e}")
            try:
                push_to_game("(我这边出了点问题，稍后再试)")
            except Exception:
                pass

if __name__ == "__main__":
    main()
