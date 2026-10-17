import React, { useState, useEffect, useRef } from 'react';
import './App.css'; // Optional styling if you have it

function App() {
  const [statusText, setStatusText] = useState('System ready. Tap screen to scan surroundings.');
  const [connectionStatus, setConnectionStatus] = useState('Connecting...');
  const [line1, setLine1] = useState('');
  const [line2, setLine2] = useState('');
  
  const videoRef = useRef(null);
  const audioRef = useRef(null);
  const audioUnlocked = useRef(false);

  // 1. Start Camera Feed (Rear facing)
  useEffect(() => {
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
      .then(stream => {
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
        }
      })
      .catch(err => {
        console.error("Camera access error:", err);
        setStatusText('Camera access denied or unavailable.');
      });
  }, []);

  // 2. Fallback Speech Synthesis if ElevenLabs audio fails
  const speakFallback = (text) => {
    const utterance = new SpeechSynthesisUtterance(text);
    window.speechSynthesis.speak(utterance);
  };

  // 3. Capture Photo & Send to Flask Backend (/narrate)
  const captureAndNarrate = async () => {
    // Unlock mobile audio on first tap
    if (!audioUnlocked.current && audioRef.current) {
      audioRef.current.play().catch(() => {});
      audioUnlocked.current = true;
    }
    if (navigator.vibrate) navigator.vibrate(100);

    setStatusText('Analyzing surroundings...');

    const video = videoRef.current;
    if (!video) return;

    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 480;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    canvas.toBlob(async (blob) => {
      const formData = new FormData();
      formData.append('image', blob, 'frame.jpg');

      try {
        // Change localhost to your laptop's local IP if testing from a physical phone!
        const response = await fetch('http://172.20.10.2:5000/narrate', {
          method: 'POST',
          body: formData,
        });

        const data = await response.json();
        if (data.error) throw new Error(data.error);

        setStatusText(data.text);

        if (data.audio && audioRef.current) {
          audioRef.current.src = `data:audio/mp3;base64,${data.audio}`;
          audioRef.current.play().catch(() => speakFallback(data.text));
        } else {
          speakFallback(data.text);
        }
      } catch (err) {
        console.error(err);
        setStatusText('AI processing failed. Using local voice fallback.');
        speakFallback('Unable to process image.');
      }
    }, 'image/jpeg', 0.8);
  };

  // 4. Update Wearable LCD Message
  const updateLCD = async () => {
    try {
      await fetch('http://172.20.10.2:5000/lcd', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ line1, line2 }),
      });
      alert('LCD updated successfully!');
    } catch (e) {
      alert('Failed to update LCD.');
    }
  };

  // 5. Poll Backend Events Every 1 Second (Listening for Arduino / Falls)
  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const res = await fetch('http://172.20.10.2:5000/events');
        const data = await res.json();
        setConnectionStatus('Online');

        if (data.events && data.events.length > 0) {
          data.events.forEach(ev => {
            if (ev.type === 'button') {
              captureAndNarrate();
            } else if (ev.type === 'fall') {
              setStatusText('🚨 FALL DETECTED! Press button if safe.');
              speakFallback('Fall detected. Press the button if you are okay.');
            } else if (ev.type === 'cancel') {
              setStatusText("Fall alert cancelled. You're safe.");
              speakFallback("Okay, glad you're safe.");
            } else if (ev.type === 'air_bad') {
              setStatusText('⚠️ Bad air quality detected!');
              speakFallback('Warning: Poor air quality detected. Please move.');
            }
          });
        }
      } catch (e) {
        setConnectionStatus('Offline');
      }
    }, 1000);

    return () => clearInterval(interval);
  }, []);

  return (
    <div style={{ background: '#000', color: '#fff', height: '100vh', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', padding: '20px', boxSizing: 'border-box' }}>
      
      {/* Hidden camera preview & audio player */}
      <div style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', zIndex: 1, opacity: 0.15, overflow: 'hidden', pointerEvents: 'none' }}>
        <video ref={videoRef} autoPlay playsInline muted style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
      </div>
      <audio ref={audioRef} style={{ display: 'none' }} />

      {/* UI Content Layer */}
      <div style={{ position: 'relative', zIndex: 2, display: 'flex', flexDirection: 'column', height: '100%', justifyContent: 'space-between' }}>
        
        <header style={{ display: 'flex', justifyContent: 'space-between', background: 'rgba(255,255,255,0.1)', padding: '10px 15px', borderRadius: '8px' }}>
          <h2 style={{ margin: 0 }}>Guardian</h2>
          <span>Status: {connectionStatus}</span>
        </header>

        {/* Giant Accessibility Button */}
        <button 
          onClick={captureAndNarrate}
          style={{ flexGrow: 1, background: '#00ff66', color: '#000', border: 'none', borderRadius: '20px', fontSize: '2.5rem', fontWeight: 'bold', margin: '20px 0', cursor: 'pointer', boxShadow: '0 0 20px rgba(0,255,102,0.5)' }}
        >
          TAP TO DESCRIBE
        </button>

        {/* Status Box */}
        <div style={{ background: 'rgba(255,255,255,0.1)', padding: '15px', borderRadius: '10px', fontSize: '1.2rem', minHeight: '60px' }}>
          {statusText}
        </div>

        {/* Settings Panel */}
        <div style={{ background: 'rgba(255,255,255,0.15)', padding: '15px', borderRadius: '10px', marginTop: '10px' }}>
          <h4 style={{ margin: '0 0 10px 0' }}>Wearable LCD Settings</h4>
          <input 
            type="text" placeholder="Line 1 (e.g. Low vision)" value={line1} onChange={e => setLine1(e.target.value)} maxLength={16}
            style={{ width: '100%', padding: '8px', marginBottom: '8px', fontSize: '1rem', boxSizing: 'border-box' }} 
          />
          <input 
            type="text" placeholder="Line 2 (e.g. Thanks for help)" value={line2} onChange={e => setLine2(e.target.value)} maxLength={16}
            style={{ width: '100%', padding: '8px', marginBottom: '8px', fontSize: '1rem', boxSizing: 'border-box' }} 
          />
          <button onClick={updateLCD} style={{ padding: '10px', background: '#00ff66', border: 'none', fontWeight: 'bold', width: '100%', fontSize: '1rem', cursor: 'pointer' }}>
            Update LCD
          </button>
        </div>

      </div>
    </div>
  );
}

export default App;






