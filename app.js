import { db } from "./firebase.js";


function createID(){

    return Math.floor(
        1000000 + Math.random() * 9000000
    ).toString();

}



let myId = localStorage.getItem("anonymous_id");


if(!myId){

    myId = createID();

    localStorage.setItem(
        "anonymous_id",
        myId
    );

}


document.getElementById("myId")
.innerText = myId;



document.getElementById("copyId")
.onclick = ()=>{

    navigator.clipboard.writeText(myId);

    alert("ה-ID הועתק");

};



document.getElementById("randomChat")
.onclick = ()=>{

    document.getElementById("status")
    .innerText =
    "מחפש משתמש...";

};



document.getElementById("connect")
.onclick = ()=>{

    const id =
    document.getElementById("targetId").value;


    if(id.length !== 7){

        alert("ID לא תקין");
        return;

    }


    alert(
        "בהמשך נתחבר למשתמש " + id
    );

};
