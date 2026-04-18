import { Component, ChangeDetectorRef } from '@angular/core';
import { DecimalPipe } from '@angular/common'; 
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { marked } from 'marked'; 

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [DecimalPipe, FormsModule], 
  templateUrl: './app.html',
  styleUrls: ['./app.css']
})
export class App {
  username = '';
  report = '';
  
  selectedPlatform = '';
  showPlatformError = false;

  selectedMood = '';
  showMoodError = false;

  loading = false;
  progressPercentage = 0;
  private progressInterval: any;

  constructor(private http: HttpClient, private cdr: ChangeDetectorRef) {}

  selectPlatform(platform: string) {
    this.selectedPlatform = platform;
    this.showPlatformError = false; 
  }

  selectMood(mood: string) {
    this.selectedMood = mood;
    this.showMoodError = false; 
  }

  getAnalysis() {
    if (!this.selectedPlatform) {
      this.showPlatformError = true;
      return;
    }
    if (!this.username) return;
    if (!this.selectedMood) {
      this.showMoodError = true;
      return;
    }
    
    this.loading = true;
    this.report = '';
    this.startFakeProgress();
    this.cdr.detectChanges();
    
    // Ensure this points to Azure for production or localhost:8080 for local testing
    const backendUrl = `https://chess-backend.gentlestone-e692d061.centralindia.azurecontainerapps.io/api/analyze/${this.selectedPlatform}/${this.username}/${this.selectedMood}`;
    
    this.http.get(backendUrl, { responseType: 'text' }).subscribe({
      next: async (data) => {
        this.finishProgress();
        // Catch backend error strings passed to frontend
        if (data.startsWith("Error")) {
            this.report = `<h3>⚠️ Request Failed</h3><p>${data}</p>`;
        } else {
            this.report = await marked.parse(data); 
        }
        this.cdr.detectChanges();
      },
      error: (err) => {
        console.error('HTTP Error:', err);
        this.resetProgress();
        this.report = '<h3>❌ Failed to fetch analysis</h3><p>Could not reach the server. Did Gemini blunder?</p>';
        this.cdr.detectChanges();
      }
    });
  }

  private startFakeProgress() {
    this.progressPercentage = 0;
    this.progressInterval = setInterval(() => {
      if (this.progressPercentage < 95) {
        let increment = Math.random() * 2; 
        this.progressPercentage = Math.min(this.progressPercentage + increment, 95);
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