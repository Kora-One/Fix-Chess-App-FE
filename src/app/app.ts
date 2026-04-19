import { Component, ChangeDetectorRef } from '@angular/core';
import { environment } from '../environments/environment';
import { DecimalPipe } from '@angular/common'; 
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { marked } from 'marked'; 
import { Chess } from 'chess.js';
import Chart from 'chart.js/auto';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [DecimalPipe, FormsModule], 
  templateUrl: './app.html',
  styleUrls: ['./app.css']
})
export class App {
  // --- UI State ---
  username = '';
  report = '';
  selectedPlatform = '';
  showPlatformError = false;
  selectedMood = '';
  showMoodError = false;
  activeTab = 'analysis';

  // --- AI Loading State ---
  loading = false;
  progressPercentage = 0;
  private progressInterval: any;

  // --- Graph State (20-Game Trend) ---
  trendChart: any;
  trendLoading = false;
  trendProgress = 0;

  constructor(private http: HttpClient, private cdr: ChangeDetectorRef) {}

  selectPlatform(platform: string) { 
    this.selectedPlatform = platform; 
    this.showPlatformError = false; 
  }

  selectMood(mood: string) { 
    this.selectedMood = mood; 
    this.showMoodError = false; 
  }

  switchTab(tab: string) { 
    this.activeTab = tab; 
    
    // Force Angular to update the HTML right this exact millisecond
    this.cdr.detectChanges(); 
    
    // Wait a tiny fraction of a second for the browser to catch up, then resize
    setTimeout(() => {
      if (tab === 'trend' && this.trendChart) {
        this.trendChart.resize();
      }
    }, 50);
  }

  getAnalysis() {
    if (!this.selectedPlatform) { this.showPlatformError = true; return; }
    if (!this.username) return;
    if (!this.selectedMood) { this.showMoodError = true; return; }
    
    this.loading = true;
    this.report = '';
    this.activeTab = 'analysis'; 
    this.startFakeProgress();
    this.cdr.detectChanges();
    
    // Fire off the background Web Worker for the trend graph
    this.generateTrendGraph();

    // We use environment.apiUrl so it automatically switches based on where it's running!
    const backendUrl = `${environment.apiUrl}/analyze/${this.selectedPlatform}/${this.username}/${this.selectedMood}`;
    
    this.http.get(backendUrl, { responseType: 'text' }).subscribe({
      next: async (data) => {
        this.finishProgress();
        if (data.startsWith("Error")) {
            this.report = `<h3>⚠️ Request Failed</h3><p>${data}</p>`;
        } else {
            this.report = await marked.parse(data); 
        }
        this.cdr.detectChanges();
      },
      error: (err) => {
        this.resetProgress();
        this.report = '<h3>❌ Failed to fetch analysis</h3>';
        this.cdr.detectChanges();
      }
    });
  }

  // --- 20 GAME TREND GRAPH ---
  async generateTrendGraph() {
    this.trendLoading = true;
    this.trendProgress = 0;
    if (this.trendChart) this.trendChart.destroy();

    try {
      const pgns = await this.fetchMultipleGames(20);
      if (!pgns || pgns.length === 0) {
        this.trendLoading = false;
        return;
      }

      const accuracies: number[] = [];
      const gameLabels: string[] = [];

      for (let i = 0; i < pgns.length; i++) {
        const accuracy = await this.calculateSingleGameAccuracy(pgns[i], this.username);
        accuracies.push(accuracy);
        gameLabels.push(`Game ${i + 1}`);
        this.trendProgress = Math.round(((i + 1) / pgns.length) * 100);
        this.cdr.detectChanges();
      }

      this.trendLoading = false;
      this.cdr.detectChanges();

      // Give the browser 50ms to hide the loading bar before Chart.js draws the graph
      setTimeout(() => {
        this.drawTrendChart(gameLabels, accuracies);
      }, 50);

    } catch (err) {
      console.error("❌ 20-GAME TREND ERROR:", err);
      this.trendLoading = false;
      this.cdr.detectChanges(); 
    }
  }

  calculateSingleGameAccuracy(pgn: string, playerUsername: string): Promise<number> {
    const chess = new Chess();
    try {
      chess.loadPgn(pgn);
    } catch (err) {
      console.warn("⚠️ Invalid PGN format skipped.");
      return Promise.resolve(0);
    }

    const headers = chess.header() as Record<string, string>;
    const isWhite = headers["White"]?.toLowerCase() === playerUsername.toLowerCase();

    // Generate ALL the FENs upfront
    const history = chess.history();
    const fens: string[] = [new Chess().fen()]; 
    const tempChess = new Chess();
    for (let move of history) {
      tempChess.move(move);
      fens.push(tempChess.fen());
    }

    const worker = new Worker("stockfish.js");
    let currentFenIndex = 0;
    let moveAccuracies: number[] = [];
    let previousWhiteEval = 0; 
    let currentWhiteEval = 0; 

    // Exponential decay math (Lichess/Chess.com style)
    const cpLossToAccuracy = (loss: number): number => {
      const acc = 100 * Math.exp(-loss / 200);
      return Math.max(0, Math.min(100, acc));
    };

    return new Promise((resolve) => {
      let failsafeTimer: any;

      const resolveFinalAccuracy = () => {
        clearTimeout(failsafeTimer);
        if (moveAccuracies.length === 0) return resolve(0);
        const avg = moveAccuracies.reduce((a, b) => a + b, 0) / moveAccuracies.length;
        resolve(Math.round(avg));
      };

      const resetFailsafe = () => {
        clearTimeout(failsafeTimer);
        
        // ⚡ Prevent the Checkmate Hang
        const timeoutTime = (currentFenIndex === fens.length - 1) ? 100 : 5000;
        
        failsafeTimer = setTimeout(() => { 
          worker.terminate(); 
          resolveFinalAccuracy();
        }, timeoutTime); 
      };

      worker.onmessage = (event) => {
        const line = event.data;
        const isBlackTurn = fens[currentFenIndex].includes(' b ');

        // Parse score and convert to Absolute White Advantage
        if (line.includes("score cp")) {
          const match = line.match(/score cp (-?\d+)/);
          if (match) {
            let cp = parseInt(match[1]);
            currentWhiteEval = isBlackTurn ? -cp : cp;
          }
        } else if (line.includes("score mate")) {
          const match = line.match(/score mate (-?\d+)/);
          if (match) {
            let mate = parseInt(match[1]);
            let mateScore = mate > 0 ? 10000 : -10000;
            currentWhiteEval = isBlackTurn ? -mateScore : mateScore;
          }
        }

        // Process the math when Stockfish finishes the depth search
        if (line.startsWith("bestmove")) {
          if (currentFenIndex > 0) {
            const whiteJustMoved = isBlackTurn;
            const blackJustMoved = !isBlackTurn;

            let loss = 0;
            let shouldRecord = false;

            const best_move_eval = previousWhiteEval; 
            const played_move_eval = currentWhiteEval;

            if (isWhite && whiteJustMoved) {
              loss = best_move_eval - played_move_eval; 
              shouldRecord = true;
            } else if (!isWhite && blackJustMoved) {
              loss = played_move_eval - best_move_eval; 
              shouldRecord = true;
            }

            if (shouldRecord) {
              if (loss < 0) loss = 0; 
              moveAccuracies.push(cpLossToAccuracy(loss));
            }
          }

          previousWhiteEval = currentWhiteEval;
          currentFenIndex++;

          if (currentFenIndex < fens.length) {
            resetFailsafe(); 
            worker.postMessage(`position fen ${fens[currentFenIndex]}`);
            worker.postMessage("go depth 10"); 
          } else {
            worker.terminate();
            resolveFinalAccuracy();
          }
        }
      };

      resetFailsafe();
      worker.postMessage("uci");
      worker.postMessage(`position fen ${fens[currentFenIndex]}`);
      worker.postMessage("go depth 10");
    });
  }

  // --- API HELPER ---
  async fetchMultipleGames(limit: number): Promise<string[]> {
    console.log(`📡 FRONTEND: Attempting to fetch ${limit} games from ${this.selectedPlatform} for user: ${this.username}...`);
    
    try {
      if (this.selectedPlatform === 'lichess') {
        const res = await fetch(`https://lichess.org/api/games/user/${this.username}?max=${limit}&variant=standard`, { headers: { 'Accept': 'application/x-chess-pgn' }});
        if (!res.ok) throw new Error(`Lichess API returned status ${res.status}`);
        
        const rawText = await res.text();
        if (!rawText) throw new Error("Lichess returned empty text");

        let parts = rawText.split('[Event "');
        parts.shift(); 
        console.log(`✅ FRONTEND: Successfully fetched ${parts.length} standard games from Lichess!`);
        return parts.map(p => '[Event "' + p);
        
      } else {
        const archivesRes = await fetch(`https://api.chess.com/pub/player/${this.username}/games/archives`);
        if (!archivesRes.ok) throw new Error(`Chess.com Archives API returned status ${archivesRes.status}`);
        
        const archivesData = await archivesRes.json();
        if (!archivesData.archives || archivesData.archives.length === 0) throw new Error("No archives found for this user.");
        
        const lastMonthUrl = archivesData.archives[archivesData.archives.length - 1];
        console.log(`📂 FRONTEND: Found archive URL, fetching games from: ${lastMonthUrl}`);
        
        const gamesRes = await fetch(lastMonthUrl);
        if (!gamesRes.ok) throw new Error(`Chess.com Games API returned status ${gamesRes.status}`);
        
        const gamesData = await gamesRes.json();
        if (!gamesData.games || gamesData.games.length === 0) throw new Error("No games found in the latest archive.");

        const total = gamesData.games.length;
        const pgns = [];
        
        for (let i = total - 1; i >= 0 && pgns.length < limit; i--) {
            if (gamesData.games[i].pgn && gamesData.games[i].rules === 'chess') {
                pgns.push(gamesData.games[i].pgn);
            }
        }
        console.log(`✅ FRONTEND: Successfully fetched ${pgns.length} standard games from Chess.com!`);
        return pgns;
      }
    } catch (e) {
      console.error("❌ FRONTEND FETCH FAILED:", e);
      return [];
    }
  }

  // --- CHART ---
  drawTrendChart(labels: string[], data: number[]) {
    const canvas = document.getElementById('trendChart') as HTMLCanvasElement;
    if (!canvas) return;
    this.trendChart = new Chart(canvas, {
      type: 'line',
      data: {
        labels: labels,
        datasets: [{
          label: 'Accuracy %', data: data, borderColor: '#2563eb', backgroundColor: 'rgba(37, 99, 235, 0.1)',
          borderWidth: 3, pointBackgroundColor: '#2563eb', pointRadius: 5, fill: true, tension: 0.4 
        }]
      },
      options: {
        responsive: true, plugins: { legend: { display: false } },
        scales: { y: { min: 0, max: 100, title: { display: true, text: 'Accuracy %' } } }
      }
    });
  }

  // --- UI LOADERS ---
  private startFakeProgress() {
    this.progressPercentage = 0;
    this.progressInterval = setInterval(() => {
      if (this.progressPercentage < 95) {
        this.progressPercentage = Math.min(this.progressPercentage + (Math.random() * 2), 95);
        this.cdr.detectChanges();
      }
    }, 250); 
  }
  
  private finishProgress() { 
    clearInterval(this.progressInterval); 
    this.progressPercentage = 100; 
    setTimeout(() => { 
        this.loading = false; 
        this.cdr.detectChanges(); 
    }, 600); 
  }
  
  private resetProgress() { 
    clearInterval(this.progressInterval); 
    this.loading = false; 
    this.progressPercentage = 0; 
  }
}