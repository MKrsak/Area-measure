# Area Measure

Simple web app: take a photo of an object lying next to a ruler and it calculates the object's area.

**How it works**
1. Take a photo (or choose an image).
2. If Chrome's built-in AI (Gemini Nano, Prompt API with image input) is available, it locates the ruler marks and the main object. Everything runs locally on your device.
3. The object outline is found with image analysis (background color model + Otsu threshold + largest centered region).
4. Area = object pixels ÷ (pixels per cm)².

You can always correct the result: drag the red ruler handles onto two tick marks and type their distance, drag a box around the object, or tap the object.

**Hosting:** plain static files (`index.html`, `app.js`, `style.css`) – served by GitHub Pages, no build step.
