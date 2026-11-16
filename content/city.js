/*
 * THE VIRTUAL CITY and THE AUGMENTED CITY: single content source.
 * Used by: vr/index.html, ar/index.html, alt/vr.html, alt/ar.html, the audio manifest,
 * the Apps Script portal (scene and scenario names) and the workshop slides.
 * Lindenbrück, its visitor centre, station services and museum collection are FICTIONAL
 * and were created for the workshop "Designing Immersive ELT Tasks: From VR and AR to Pedagogy".
 * Panoramas, photographs and the 3D jar are AI-generated (Higgsfield); voices are synthetic (ElevenLabs).
 *
 * Hotspot types:
 *   listen   audio input with transcript (learner view)
 *   look     contextual information (learner view)
 *   language language scaffold at about CEFR B1 (learner view)
 *   decide   communicative problem that needs a decision (learner view)
 *   lens     "teacher lens": a prompt about pedagogical affordances (teacher view)
 *   go       scene transition
 *
 * Audio: every clip has two files. `file` carries scene-appropriate sound design (station loudspeaker,
 * telephone line, gallery reverberation); `clean` is the same voice with no effects, offered as an
 * accessibility option next to every player. `fx` describes the sound design in words.
 */
window.CITY = {
  version: "1.0.0",
  city: "Lindenbrück",
  disclaimer: "Lindenbrück, its services and its museum collection are fictional and were created for this workshop. Scenes, photographs and the 3D object are AI-generated; voices are synthetic.",
  audioBase: "../assets/audio/",
  audio: {
    "vrA_dialogue": { file: "vrA_dialogue.mp3", clean: "vrA_dialogue_clean.mp3", fx: "Four turns joined with 0.45 s pauses; faint interior room tone.", title: "At the information desk", speakers: "Visitor (Will voice), Information officer (Alice voice)", cefr: "B1",
      transcript: [
        ["Visitor", "Hi, sorry to bother you. My friend and I are only here until this evening. She loves history, but honestly, I just want good food and somewhere to sit down. What would you recommend?"],
        ["Officer", "No problem at all! Well, the Market Hall is perfect for food, but it closes at two o'clock, so I'd go there first. After that, the Museum of Culture is only two tram stops away, and it's open until six. Your friend will love the Festivals of Light exhibition."],
        ["Visitor", "That sounds great. And what about the Clock Tower? Is it far from here?"],
        ["Officer", "Not at all, it's a five-minute walk, just across the Old Bridge. But there are a hundred and forty-two steps and no lift, so maybe enjoy the view from the bridge instead. Here's a map. Have a lovely afternoon!"]
      ] },
    "vrB_announcement_delay": { file: "vrB_announcement_delay.mp3", clean: "vrB_announcement_delay_clean.mp3", fx: "Three-note chime, loudspeaker band-limiting, concourse echo and low station ambience.", title: "Platform change announcement", speakers: "Station announcer (Daniel voice)", cefr: "B1",
      transcript: [["Announcer", "Attention, please. This is a platform change announcement. The eleven-oh-two Intercity service to Hamburg is delayed by approximately thirty-five minutes. This train will now depart from platform two, not platform one. We apologise for the inconvenience."]] },
    "vrB_announcement_cancel": { file: "vrB_announcement_cancel.mp3", clean: "vrB_announcement_cancel_clean.mp3", fx: "Three-note chime, loudspeaker band-limiting, concourse echo and low station ambience.", title: "Cancellation announcement", speakers: "Station announcer (Daniel voice)", cefr: "B1",
      transcript: [["Announcer", "Attention, please. The eleven forty-six service to Cologne has been cancelled today because of a technical problem. A replacement bus will leave from bus stop B, in front of the station, at twelve o'clock. Tickets for the cancelled train are valid on the bus."]] },
    "vrB_clerk_options": { file: "vrB_clerk_options.mp3", clean: "vrB_clerk_options_clean.mp3", fx: "Voice through a ticket-window speaker; low station ambience.", title: "At the ticket office", speakers: "Ticket clerk (Eric voice)", cefr: "B1",
      transcript: [["Clerk", "Right, you've got two options. You can keep your ticket and wait for the delayed train. It leaves at eleven thirty-seven from platform two. Or you can take the next direct train at two minutes past twelve. There's no extra charge, but your seat reservation won't be valid on that one, so you might have to stand. What would you like to do?"]] },
    "vrC_guide_painting": { file: "vrC_guide_painting.mp3", clean: "vrC_guide_painting_clean.mp3", fx: "Light gallery reverberation and very quiet room tone.", title: "The River of Lights", speakers: "Museum guide (Jessica voice)", cefr: "B1",
      transcript: [["Guide", "This painting shows the River of Lights, the oldest festival in our collection. On the last evening of summer, families wrote one hope for the coming year on a paper lantern and placed it on the water. Look at the people on the left: they are not watching the lanterns, they are watching each other. For the artist, the festival was really about the community. Does your own culture have a celebration like this?"]] },
    "vrC_guide_lanterns": { file: "vrC_guide_lanterns.mp3", clean: "vrC_guide_lanterns_clean.mp3", fx: "Light gallery reverberation and very quiet room tone.", title: "Why lanterns?", speakers: "Museum guide (Jessica voice)", cefr: "B1",
      transcript: [["Guide", "These paper lanterns were made by hand, and each family had its own pattern. The red ones were for good health, and the white ones were for remembering people who had died. They were never sold. You could only receive one as a gift. So here is my question for you: should a museum let visitors touch copies of objects like these? What do you think, and why?"]] },
    "arA_tip": { file: "arA_tip.mp3", clean: "arA_tip_clean.mp3", fx: "Two-note app notification, then the voice unprocessed.", title: "Today's insider tip", speakers: "Information officer (Alice voice)", cefr: "B1",
      transcript: [["Officer", "Here's today's insider tip. The Clock Tower is closed for repairs, so the view from the Old Bridge is your best photo spot. The Market Hall closes at two, and the food tour at eleven is already full. But the Palm House is quiet today and open until six. If I were you, I'd change the order of your afternoon."]] },
    "arB_update": { file: "arB_update.mp3", clean: "arB_update_clean.mp3", fx: "Three-note chime and loudspeaker treatment, no ambience bed.", title: "Live service update", speakers: "Station announcer (Daniel voice)", cefr: "B1",
      transcript: [["Announcer", "Live update for Lindenbrück Central. The eleven-oh-two to Hamburg is delayed by thirty-five minutes and will leave from platform two. The eleven forty-six to Cologne is cancelled. A replacement bus leaves from stop B at twelve o'clock. All other services are running on time."]] },
    "arC_curator": { file: "arC_curator.mp3", clean: "arC_curator_clean.mp3", fx: "Soft audio-guide tone, then the voice with light gallery reverberation.", title: "The curator's note", speakers: "Museum guide (Jessica voice)", cefr: "B1",
      transcript: [["Curator", "You are looking at the Storytelling Jar. Turn it slowly. The painter did not sign the jar. Instead, the story is the signature. Start at the river, follow the boats, and you will reach the lanterns. Every family in the town could find their own boat in the picture. If you had to explain this object to a friend in thirty seconds, what would you say first?"]] },
    "elt_voicemail": { file: "elt_voicemail.mp3", clean: "elt_voicemail_clean.mp3", fx: "Answering-machine beep, telephone bandwidth (300 to 3400 Hz, 8 kHz resampling), faint line noise, end tones.", title: "Voicemail: river cruise booking", speakers: "Cruise office (Chris voice)", cefr: "B1",
      transcript: [["Caller", "Hello, this is a message for Sam from Lindenbrück River Cruises. I'm calling about your booking for two people this afternoon. Unfortunately, the two o'clock cruise is cancelled because of strong wind. We can move you to the four o'clock cruise, or give you a full refund. Please call us back before one o'clock and tell us which you prefer. Thank you, and sorry for the change."]] }
  },

  /* ---------------------------------------------------------------- VR */
  scenes: [
    { id: "visitor-centre", letter: "A", title: "Tourist Information Centre", short: "Visitor Centre",
      image: "../assets/pano/visitor-centre.jpg", imageLite: "../assets/pano/visitor-centre-lite.jpg", yaw: -100, pitch: -2,
      summary: "A bright visitor centre beside the river. A staff member stands at the information desk; there is a wall map of the city, a rack of brochures, two visitors planning with a paper map, souvenirs, and windows onto the Old Bridge and the Clock Tower.",
      functions: ["Seeking information", "Recommending attractions", "Negotiating itineraries", "Explaining preferences"],
      views: [
        { file: "../assets/alt/visitor-centre-view1.jpg", alt: "The curved wooden information desk under a sign reading Tourist Information. A staff member in a dark waistcoat smiles from behind the desk, next to a vase of flowers and a screen." },
        { file: "../assets/alt/visitor-centre-view2.jpg", alt: "A large illustrated wall map under a sign reading City Map. A blue river curves through the old town; three landmark buildings are drawn on the map." },
        { file: "../assets/alt/visitor-centre-view3.jpg", alt: "A rack of colourful brochures, a wall screen showing the riverside, and two visitors in armchairs studying a paper map over a small round table." },
        { file: "../assets/alt/visitor-centre-view4.jpg", alt: "Large windows looking out on the river, the stone Old Bridge and the Clock Tower, beside a shelf of souvenirs and a stand of postcards." }
      ],
      hotspots: [
        { id: "A1", type: "listen", yaw: -136, pitch: -1, title: "At the information desk", audio: "vrA_dialogue",
          text: "A visitor asks the information officer for advice. Listen once without the transcript.",
          task: "You have one afternoon and 15 euros each. Using what the officer said, choose two things to do. Tell your partner your choice and one reason." },
        { id: "A2", type: "look", yaw: -77, pitch: 0, title: "City map",
          text: "From the Visitor Centre: Old Bridge and Clock Tower, 5 minutes on foot. Market Hall, 8 minutes on foot. Central Station, 10 minutes on foot. Museum of Culture, 12 minutes on foot or 2 stops on tram 4. Palm House in the Botanical Garden, 5 stops on tram 4.",
          task: "Your partner cannot see the map. Describe the quickest way to visit the Market Hall and the Museum of Culture this afternoon." },
        { id: "A3", type: "language", yaw: -36, pitch: -6, title: "Brochure rack: useful language",
          phrases: ["Could you recommend something for…?", "We'd rather… because…", "How far is it on foot?", "Is it suitable for someone who…?", "What time does it close?", "That sounds good, but what about…?"],
          text: "Language for asking for recommendations and explaining preferences (about CEFR B1)." },
        { id: "A4", type: "decide", yaw: -12, pitch: -18, title: "Help these visitors decide",
          text: "Visitor A loves history and views but hates crowds. Visitor B is hungry and has a sore foot. They have three hours.",
          task: "In pairs, take one visitor each. Negotiate an itinerary that both of you accept. You have two minutes, and you must agree on the order of the visits." },
        { id: "A5", type: "lens", yaw: 110, pitch: 6, title: "Teacher lens: looking around",
          text: "Turn and look through the window, then back to the desk and the map.",
          task: "Which feature of this 360° scene could a learner use that a single textbook photo could not offer? Is that feature necessary for the language you want learners to produce? Note one idea for the Task Analyzer." },
        { id: "A6", type: "go", yaw: 160, pitch: -4, title: "Walk to Central Station", to: "central-station" }
      ] },
    { id: "central-station", letter: "B", title: "Train Station", short: "Central Station",
      image: "../assets/pano/central-station.jpg", imageLite: "../assets/pano/central-station-lite.jpg", yaw: -40, pitch: 2,
      summary: "The concourse of Lindenbrück Central under a glass roof. There is a ticket office, ticket machines, a departure board, doors to platforms 1 and 2 with a train waiting, a café kiosk, travellers on benches, an information point and a station clock.",
      functions: ["Requesting clarification", "Solving travel problems", "Comparing alternatives", "Negotiating decisions"],
      views: [
        { file: "../assets/alt/central-station-view1.jpg", alt: "A ticket office with a clerk behind glass under a sign reading Tickets, next to a row of blue self-service ticket machines." },
        { file: "../assets/alt/central-station-view2.jpg", alt: "A digital departure board listing six trains with times, destinations and platforms. Every train is shown as on time." },
        { file: "../assets/alt/central-station-view3.jpg", alt: "Glass doors under a sign reading Platforms 1-2. Through the doors a white regional train is waiting at platform 2." },
        { file: "../assets/alt/central-station-view4.jpg", alt: "Travellers with suitcases sitting on metal benches, a café kiosk to the left and a round information point to the right under a large station clock." }
      ],
      hotspots: [
        { id: "B1", type: "look", yaw: -72, pitch: 9, title: "Departure board",
          table: { head: ["Time", "Destination", "Platform", "Status"], rows: [["10:24", "Berlin Hbf", "1", "On time"], ["10:37", "Munich Hbf", "2", "On time"], ["11:02", "Hamburg Hbf", "1", "On time"], ["11:18", "Frankfurt (Main)", "2", "On time"], ["11:46", "Cologne Hbf", "1", "On time"], ["12:03", "Stuttgart Hbf", "2", "On time"]] },
          text: "The board shows every train as on time. Keep this in mind when you listen to the announcement.",
          task: "Your ticket is for the 11:02 to Hamburg. Which platform do you expect, according to the board?" },
        { id: "B2", type: "listen", yaw: 154, pitch: 20, title: "Station announcement", audio: "vrB_announcement_delay",
          text: "An announcement comes over the loudspeaker. It does not match the board.",
          task: "The board says one thing and the announcement says another. What exactly would you ask at the information point? Say your question aloud." },
        { id: "B3", type: "listen", yaw: -154, pitch: -4, title: "At the ticket office", audio: "vrB_clerk_options",
          text: "The ticket clerk explains your options.",
          task: "You are travelling with a friend. One of you wants to wait for the delayed train; the other wants the 12:02 without a reserved seat. Compare the two options and agree on one." },
        { id: "B4", type: "language", yaw: 150, pitch: -6, title: "Information point: checking you understood",
          phrases: ["Sorry, could you say that again, please?", "Do you mean platform two?", "So, if I understand correctly, …", "Is my ticket still valid?", "What happens to my seat reservation?", "Which option would you recommend?"],
          text: "Language for requesting clarification and confirming information (about CEFR B1)." },
        { id: "B5", type: "listen", yaw: 114, pitch: -16, title: "A second announcement", audio: "vrB_announcement_cancel",
          text: "The travellers on the benches look up. Another announcement follows.",
          task: "A traveller next to you did not understand the announcement. Explain to them, in your own words, what has changed and what they should do." },
        { id: "B6", type: "lens", yaw: 70, pitch: -4, title: "Teacher lens: is the scene doing any work?",
          text: "The same announcement could be played from a classroom speaker.",
          task: "What, if anything, does hearing the announcement inside the station scene add for the learner? Be critical: name one thing it adds and one thing it does not." },
        { id: "B7", type: "go", yaw: 0, pitch: -4, title: "Take tram 4 to the Museum of Culture", to: "museum" },
        { id: "B8", type: "go", yaw: -110, pitch: -12, title: "Back to the Visitor Centre", to: "visitor-centre" }
      ] },
    { id: "museum", letter: "C", title: "Cultural Museum", short: "Museum of Culture",
      image: "../assets/pano/museum.jpg", imageLite: "../assets/pano/museum-lite.jpg", yaw: -70, pitch: 0,
      summary: "Gallery 2 of the Museum of Culture, home of the fictional Festivals of Light exhibition. There are painted ceramic jars in a glass case, a large painting of a river lantern festival, woven textiles, an illustrated timeline, a guide talking with two visitors, a case of paper lanterns, a bench, and an archway to the next gallery.",
      functions: ["Cultural mediation", "Interpretation", "Comparison", "Explanation", "Justified opinions"],
      views: [
        { file: "../assets/alt/museum-view1.jpg", alt: "A glass display case holding six painted ceramic jars in blue, white and orange, each with a small printed label." },
        { file: "../assets/alt/museum-view2.jpg", alt: "A large gold-framed painting of a river festival at dusk. Crowds stand on the bank, boats carry people, and glowing lanterns float on the water." },
        { file: "../assets/alt/museum-view3.jpg", alt: "A wall panel with an illustrated timeline under signs reading Museum of Culture and Gallery 2. A guide with a lanyard is speaking to two visitors." },
        { file: "../assets/alt/museum-view4.jpg", alt: "A glass case with five hand-painted paper lanterns in white and red, next to a framed historical photograph and a wooden bench." }
      ],
      hotspots: [
        { id: "C1", type: "listen", yaw: -97, pitch: 2, title: "The River of Lights", audio: "vrC_guide_painting",
          text: "The guide introduces the largest painting in the gallery.",
          task: "Answer the guide's question. Describe one celebration from your own culture and name two similarities and one difference." },
        { id: "C2", type: "look", yaw: -155, pitch: -4, title: "Object label: the Storytelling Jar",
          text: "Painted ceramic with lid. A river, small boats and floating lanterns circle the jar. Families looked for their own boat in the picture. The painter did not sign the jar: the story is the signature.",
          task: "Your friend does not read English. Explain the label to them in simple English. What would you leave out, and what would you keep?" },
        { id: "C3", type: "language", yaw: 20, pitch: 2, title: "Timeline panel: language for mediation",
          phrases: ["This shows…", "The main idea is that…", "It's a bit like… in my country.", "What surprised me is…", "In other words, …", "I think the artist wanted to…"],
          text: "Language for explaining, comparing and passing on meaning (about CEFR B1, mediation)." },
        { id: "C4", type: "decide", yaw: 46, pitch: -14, title: "Be the guide",
          text: "Two visitors have joined the tour late. They missed the explanation of the painting.",
          task: "In pairs: one of you is the guide, the other a late visitor who asks two questions. The guide has one minute. Then swap roles and choose a different object." },
        { id: "C5", type: "listen", yaw: 90, pitch: 0, title: "Why lanterns?", audio: "vrC_guide_lanterns",
          text: "The guide stops at the lantern case and asks for your opinion.",
          task: "Give your opinion and one reason. Then respond to a partner who disagrees with you." },
        { id: "C6", type: "lens", yaw: 129, pitch: -20, title: "Teacher lens: where is the learner's agency?",
          text: "Sit on the bench for a moment and look back at the whole gallery.",
          task: "What can the learner actually choose in this scene: where to look, what to listen to, which object to explain? Does that choice change the language they produce, or only what they look at?" },
        { id: "C7", type: "go", yaw: 163, pitch: -4, title: "Leave the museum: back to the Visitor Centre", to: "visitor-centre" }
      ] }
  ],
  vrCompletion: { minScenes: 3, minHotspots: 4 },

  /* ---------------------------------------------------------------- AR */
  /* Target plane: width 1, height 0.625 (1600 x 1000 px). u, v are fractions of the target image from its top-left corner. */
  arTargetsFile: "../assets/targets/targets.mind",
  arScenarios: [
    { id: "brochure", index: 0, letter: "A", title: "Augmented Tourist Brochure", target: "../assets/targets/brochure.png",
      printed: "The printed brochure lists opening times and prices for three places. Printed information goes out of date.",
      learnerTask: "It is 12:30. Use today's live information to re-plan the printed 'one afternoon' route. Tell your partner what you would change, and why.",
      lens: "The brochure is printed; the overlay is live. Which language functions does that gap create (for example reporting changes or re-planning)? Could a slide with the same updates do the same job?",
      items: [
        { id: "arA1", u: 0.165, v: 0.40, kind: "live", label: "Market Hall", chip: "TODAY", lines: ["Closes 14:00", "Food tour 11:00: FULL"], colour: "#c2452d",
          text: "Live information: the Market Hall closes at 14:00 today. The 11:00 food tour is already full." },
        { id: "arA2", u: 0.50, v: 0.40, kind: "live", label: "Palm House", chip: "TODAY", lines: ["Open until 18:00", "Quiet now · Students €3"], colour: "#1f7a6d",
          text: "Live information: the Palm House is open until 18:00 and is quiet at the moment. Students pay 3 euros." },
        { id: "arA3", u: 0.815, v: 0.40, kind: "live", label: "Clock Tower", chip: "TODAY", lines: ["Tower CLOSED (repairs)", "Bridge walk open"], colour: "#17233c",
          text: "Live information: the Clock Tower is closed for repairs today. The walk across the Old Bridge is open." },
        { id: "arA4", u: 0.50, v: 0.94, kind: "audio", label: "Insider tip", chip: "LISTEN", lines: ["Today's insider tip", "Tap to listen"], colour: "#e8a838", audio: "arA_tip",
          text: "The information officer has recorded a tip for today." }
      ] },
    { id: "timetable", index: 1, letter: "B", title: "Augmented Transport Information", target: "../assets/targets/timetable.png",
      printed: "The printed timetable shows six departures. It cannot show delays, cancellations or platform changes.",
      learnerTask: "Your ticket is for the 11:46 to Cologne. Explain the problem to your travel partner, and agree on two questions to ask at the information point.",
      lens: "The overlay changes what the printed page means. Is the learner reading, deciding or negotiating here? Which of these does your language objective need?",
      items: [
        { id: "arB1", u: 0.985, v: 0.506, kind: "live", label: "11:02 Hamburg Hbf", chip: "DELAYED", lines: ["+35 min · now 11:37", "Platform 2 (not 1)"], colour: "#e8a838",
          text: "Live information: the 11:02 to Hamburg is delayed by 35 minutes and will leave from platform 2 at 11:37." },
        { id: "arB2", u: 0.985, v: 0.710, kind: "live", label: "11:46 Cologne Hbf", chip: "CANCELLED", lines: ["Replacement bus 12:00", "Bus stop B · tickets valid"], colour: "#c2452d",
          text: "Live information: the 11:46 to Cologne is cancelled. A replacement bus leaves from bus stop B at 12:00. Train tickets are valid on the bus." },
        { id: "arB3", u: 0.985, v: 0.302, kind: "live", label: "10:24 Berlin Hbf", chip: "DEPARTED", lines: ["Left on time", "Next service 12:24"], colour: "#5b6b88",
          text: "Live information: the 10:24 to Berlin has departed. The next service is at 12:24." },
        { id: "arB4", u: 0.66, v: 0.94, kind: "audio", label: "Live update", chip: "LISTEN", lines: ["Live service update", "Tap to listen"], colour: "#1f7a6d", audio: "arB_update",
          text: "The station has published a spoken service update." }
      ] },
    { id: "museum", index: 2, letter: "C", title: "Augmented Museum Object", target: "../assets/targets/museum.png", model: "../assets/models/storytelling-jar.glb",
      printed: "The printed label shows one photograph of the jar. You cannot see the other side of the object.",
      learnerTask: "Turn the jar. Then explain to a friend who does not read English what the jar shows, and compare it with a festival you know: two similarities and one difference.",
      lens: "Here the learner can turn an object that is not physically present. Does handling the object change what they can say about it, or would three photographs be enough?",
      items: [
        { id: "arC1", u: 0.30, v: 0.62, kind: "note", label: "The river", chip: "LOOK", lines: ["Start here", "The river circles the jar"], colour: "#1b3a6b",
          text: "The river runs all the way around the jar. Follow it to read the story in order." },
        { id: "arC2", u: 0.30, v: 0.30, kind: "note", label: "The lanterns", chip: "LOOK", lines: ["One hope each", "for the coming year"], colour: "#d98a2b",
          text: "Each lantern carries one hope for the coming year. Red lanterns stood for good health." },
        { id: "arC3", u: 0.82, v: 0.60, kind: "audio", label: "Curator's note", chip: "LISTEN", lines: ["The curator's note", "Tap to listen"], colour: "#8a3a22", audio: "arC_curator",
          text: "The curator explains how to read the jar." }
      ] }
  ],
  arCompletion: { minItems: 2 }
};
