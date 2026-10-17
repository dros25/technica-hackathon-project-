import os
import base64
from flask import Flask, request, jsonify
from flask_cors import CORS
from dotenv import load_dotenv
from openai import OpenAI
from elevenlabs.client import ElevenLabs

load_dotenv()

app = Flask(__name__)
CORS(app)  # Allows your frontend web app to talk to this backend smoothly

# Initialize OpenRouter Client (Using OpenAI-compatible structure)
ai_client = OpenAI(
    base_url="https://openrouter.ai/api/v1",
    api_key=os.getenv("OPENROUTER_API_KEY"),
)

# Initialize ElevenLabs TTS Client
eleven_client = ElevenLabs(api_key=os.getenv("ELEVENLABS_API_KEY"))

# --- MOCK HARDWARE (Safe fallback if Arduino isn't plugged in) ---
class MockHardware:
    def __init__(self):
        self.air = 350
        self.events = []
    def get_events(self):
        evs = self.events.copy()
        self.events.clear()
        return evs
    def set_lcd(self, line1, line2):
        print(f"[LCD MOCK] Line 1: {line1} | Line 2: {line2}")
    def alarm(self, state):
        print(f"[ALARM MOCK]: {state}")
    def test_fall(self):
        self.events.append({"type": "fall"})

# Automatically look for your partner's hardware module, or use Mock
try:
    import sys
    sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '../hardware')))
    import hardware as hw
    print("Real hardware loaded successfully.")
except ImportError:
    print("No hardware module found. Running in MOCK hardware mode.")
    hw = MockHardware()

@app.route("/")
def health_check():
    return jsonify({"status": "Guardian Backend Online via OpenRouter"})

@app.route("/narrate", methods=["POST"])
def narrate():
    try:
        image_file = request.files['image']
        image_bytes = image_file.read()

        # Convert image to base64 data URI for OpenRouter vision parsing
        base64_image = base64.b64encode(image_bytes).decode('utf-8')
        image_url = f"data:image/jpeg;base64,{base64_image}"

        # Call the vision model via OpenRouter
        response = ai_client.chat.completions.create(
            model="google/gemini-2.5-flash",  # <--- JUST CHANGE THIS STRING TO MATCH YOUR OPENROUTER MODEL SLUG IF NEEDED
            messages=[
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "text", 
                            "text": "You are guiding a blind person. In 1-2 short sentences, describe what's directly ahead, mentioning obstacles, doors, steps, and people first."
                        },
                        {
                            "type": "image_url", 
                            "image_url": {"url": image_url}
                        }
                    ]
                }
            ]
        )
        description = response.choices[0].message.content

        # Convert the AI description text into audio via ElevenLabs
        audio_stream = eleven_client.text_to_speech.convert(
            voice_id="JBFqnCBsd6RMkjVDRZzb",
            output_format="mp3_44100_128",
            text=description,
            model_id="eleven_multilingual_v2",
        )
        audio_bytes = b"".join(audio_stream)
        audio_b64 = base64.b64encode(audio_bytes).decode('utf-8')

        return jsonify({"text": description, "audio": audio_b64})
        
    except Exception as e:
        print(f"Error in /narrate: {e}")
        return jsonify({"error": str(e)}), 500

@app.route("/events", methods=["GET"])
def get_events():
    return jsonify({
        "events": hw.get_events(),
        "air": hw.air
    })

@app.route("/lcd", methods=["POST"])
def update_lcd():
    data = request.json
    hw.set_lcd(data.get("line1", ""), data.get("line2", ""))
    return jsonify({"status": "success"})

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=False, use_reloader=False)
