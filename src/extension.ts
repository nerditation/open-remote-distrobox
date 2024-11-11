import { exec } from 'child_process';
import { promisify } from 'util';
import * as vscode from 'vscode';

const exec_async = promisify(exec);

export function activate(context: vscode.ExtensionContext) {
	console.log('Congratulations, your extension "proposed-api-sample" is now active!');

	context.subscriptions.push(
		vscode.window.registerTreeDataProvider("distrobox.guests", new DistroboxLister)
	);
}

class DistroboxLister implements vscode.TreeDataProvider<string> {
	getTreeItem(element: string): vscode.TreeItem | Thenable<vscode.TreeItem> {
		return new vscode.TreeItem(element)
	}
	async getChildren(element?: string | undefined): Promise<string[]> {
		if (element) {
			return []
		} else {
			const { stdout } = await exec_async("flatpak-spawn --host distrobox list");
			let distrobox_list_output = stdout.split("\n");
			distrobox_list_output.shift();
			return distrobox_list_output;
		}
	}
}
