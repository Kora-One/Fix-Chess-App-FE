import { Component, ChangeDetectorRef } from '@angular/core';
import { DecimalPipe } from '@angular/common'; 
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { Subscription } from 'rxjs'; // ⚡ ADDED for canceling API calls
import { marked } from 'marked'; 
import { Chess } from 'chess.js';
import Chart from 'chart.js/auto';
import { environment } from '../environments/environment';

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
  analyzingUsername = '';
  report = '';
  selectedPlatform = '';
  showPlatformError = false;
  selectedMood = '';
  showMoodError = false;
  activeTab = 'analysis';
  noGamesFound = false;

  // --- AI Loading State ---
  loading = false;
  progressPercentage = 0;
  private progressInterval: any;

  // --- Graph State (20-Game Trend) ---
  trendChart: any;
  trendLoading = false;
  trendProgress = 0;

  // --- Graph State (Openings) ---
  overallStats = { wins: 0, draws: 0, losses: 0, winPct: 0, drawPct: 0, lossPct: 0 };
  openingStats: any[] = [];
  openingLoading = false;

  // --- ⚡ Cancellation Tracking ⚡ ---
  private currentAnalysisId = 0; 
  private activeWorkers: Worker[] = [];
  private analysisSub?: Subscription;

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

  // ⚡ NEW METHOD: Instantly kills old API calls and Stockfish calculations
  cancelCurrentAnalysis() {
    this.currentAnalysisId++; 
    
    if (this.analysisSub) {
      this.analysisSub.unsubscribe(); 
    }
    
    this.activeWorkers.forEach(worker => worker.terminate()); 
    this.activeWorkers = [];

    this.loading = false;
    this.trendLoading = false;
    this.openingLoading = false;
    this.noGamesFound = false; // ⚡ ADD THIS
    clearInterval(this.progressInterval);
  }

  getAnalysis() {
    if (!this.selectedPlatform) { this.showPlatformError = true; return; }
    if (!this.username) return;
    if (!this.selectedMood) { this.showMoodError = true; return; }
    
    this.cancelCurrentAnalysis(); // ⚡ Instantly kill anything that is currently running

    this.analyzingUsername = this.username; // Lock in the new username
    
    this.loading = true;
    this.report = '';
    this.activeTab = 'analysis'; 
    this.startFakeProgress();
    this.cdr.detectChanges();
    
    // Fire off the background graphs
    this.generateTrendGraph();
    this.generateOpeningGraph();

    const backendUrl = `${environment.apiUrl}/analyze/${this.selectedPlatform}/${this.username}/${this.selectedMood}`;
    
    // ⚡ Assign the HTTP call to analysisSub so we can cancel it later
    this.analysisSub = this.http.get(backendUrl, { responseType: 'text' }).subscribe({
      next: async (data) => {
        this.finishProgress();
        if (data.startsWith("Error")) {
            this.report = ` `;
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

    const thisAnalysis = this.currentAnalysisId; // ⚡ Take a snapshot of the current ID

    try {
      const pgns = await this.fetchMultipleGames(20);
      
      if (this.currentAnalysisId !== thisAnalysis) return; // ⚡ Escape if canceled!
      
      if (!pgns || pgns.length === 0) {
        this.noGamesFound = true;
        this.trendLoading = false;
        return;
      }

      const accuracies: number[] = [];
      const gameLabels: string[] = [];

      for (let i = 0; i < pgns.length; i++) {
        if (this.currentAnalysisId !== thisAnalysis) return; // ⚡ Escape if canceled!

        const accuracy = await this.calculateSingleGameAccuracy(pgns[i], this.username);
        accuracies.push(accuracy);
        gameLabels.push(`Game ${i + 1}`);
        this.trendProgress = Math.round(((i + 1) / pgns.length) * 100);
        this.cdr.detectChanges();
      }

      this.trendLoading = false;
      this.cdr.detectChanges();

      setTimeout(() => {
        if (this.currentAnalysisId === thisAnalysis) {
          this.drawTrendChart(gameLabels, accuracies);
        }
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

    const history = chess.history();
    const fens: string[] = [new Chess().fen()]; 
    const tempChess = new Chess();
    for (let move of history) {
      tempChess.move(move);
      fens.push(tempChess.fen());
    }

    const worker = new Worker("stockfish.js");
    this.activeWorkers.push(worker); // ⚡ Track this worker so we can kill it if the user clicks restart!

    let currentFenIndex = 0;
    let moveAccuracies: number[] = [];
    let previousWhiteEval = 0; 
    let currentWhiteEval = 0; 

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
        const timeoutTime = (currentFenIndex === fens.length - 1) ? 100 : 5000;
        failsafeTimer = setTimeout(() => { 
          worker.terminate(); 
          this.activeWorkers = this.activeWorkers.filter(w => w !== worker); // ⚡ Remove from tracking
          resolveFinalAccuracy();
        }, timeoutTime); 
      };

      worker.onmessage = (event) => {
        const line = event.data;
        const isBlackTurn = fens[currentFenIndex].includes(' b ');

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
            this.activeWorkers = this.activeWorkers.filter(w => w !== worker); // ⚡ Remove from tracking
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

  // --- OPENING REPERTOIRE GRAPH ---
  async generateOpeningGraph() {
    this.openingLoading = true;
    this.openingStats = []; 
    this.overallStats = { wins: 0, draws: 0, losses: 0, winPct: 0, drawPct: 0, lossPct: 0 };
    let totalGames = 0;

    const thisAnalysis = this.currentAnalysisId; // ⚡ Snapshot ID

    try {
      const pgns = await this.fetchMultipleGames(20);
      
      if (this.currentAnalysisId !== thisAnalysis) return; // ⚡ Escape if canceled!

      if (!pgns || pgns.length === 0) {
        this.noGamesFound = true;
        this.openingLoading = false;
        return;
      }

      const stats: Record<string, any> = {};

      for (let pgn of pgns) {
        const chess = new Chess();
        try { chess.loadPgn(pgn); } catch (err) { continue; }

        const headers = chess.header() as Record<string, string>;
        const isWhite = headers['White']?.toLowerCase() === this.username.toLowerCase();
        const result = headers['Result']; 

        let opening = headers['Opening'];

        if (!opening && headers['ECOUrl']) {
          const urlMatch = headers['ECOUrl'].match(/\/openings\/([^/]+)/);
          if (urlMatch) {
            opening = urlMatch[1].split(/-\d+\./)[0].replace(/-/g, ' ');
          }
        }

        opening = opening || headers['ECO'] || 'Unknown Opening';
        opening = opening.split(':')[0].trim(); 
        const colorPlayed = isWhite ? 'White' : 'Black';
        
        const key = `${opening}-${colorPlayed}`;

        if (!stats[key]) {
          stats[key] = { id: key, name: opening, color: colorPlayed, wins: 0, losses: 0, draws: 0 };
        }

        if (result === '1/2-1/2') {
          stats[key].draws++;
          this.overallStats.draws++;
        } else if ((isWhite && result === '1-0') || (!isWhite && result === '0-1')) {
          stats[key].wins++;
          this.overallStats.wins++;
        } else {
          stats[key].losses++;
          this.overallStats.losses++;
        }
        
        totalGames++;
      }

      if (totalGames > 0) {
        this.overallStats.winPct = (this.overallStats.wins / totalGames) * 100;
        this.overallStats.drawPct = (this.overallStats.draws / totalGames) * 100;
        this.overallStats.lossPct = (this.overallStats.losses / totalGames) * 100;
      }

      this.openingStats = Object.values(stats).map((s: any) => {
        const total = s.wins + s.losses + s.draws;
        return {
          ...s,
          total: total,
          winPct: (s.wins / total) * 100,
          drawPct: (s.draws / total) * 100,
          lossPct: (s.losses / total) * 100
        };
      }).sort((a, b) => b.total - a.total); 

      this.openingLoading = false;
      this.cdr.detectChanges();

    } catch (err) {
      console.error("❌ OPENING GRAPH ERROR:", err);
      this.openingLoading = false;
      this.cdr.detectChanges();
    }
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

  // --- CHARTS ---
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